const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const PORT = Number(process.env.PORT || 7000);
const CACHE_SECONDS = Number(process.env.CACHE_SECONDS || 300);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15000);

const cache = new Map();

function cached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function putCache(key, data, ttlSec = CACHE_SECONDS) {
  cache.set(key, { data, expiresAt: Date.now() + ttlSec * 1000 });
  return data;
}

async function fetchWithRetry(path, options = {}) {
  const candidates = [
    `https://phim.nguonc.com/api/films${path}`,
    `https://phim.nguonc.com/api${path}`
  ];

  let lastErr = null;
  for (const url of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (res.ok) {
        return await res.json();
      }
      lastErr = new Error(`HTTP ${res.status} at ${url}`);
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr || new Error("Failed to fetch API");
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function extractMovie(payload) {
  if (!payload) return null;
  if (payload.movie) return payload.movie;
  if (payload.item) return payload.item;
  if (payload.data && payload.data.item) return payload.data.item;
  if (payload.data && payload.data.movie) return payload.data.movie;
  return payload;
}

function extractItems(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.items)) return payload.items;
  if (payload.data && Array.isArray(payload.data.items)) return payload.data.items;
  if (payload.data && Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function parseSlugAndIndex(rawId) {
  const clean = String(rawId || "").replace(/^nguonc:/, "");
  const parts = clean.split(":");
  return {
    slug: parts[0],
    sIdx: parseInt(parts[1] || "0", 10),
    epIdx: parseInt(parts[2] || "0", 10)
  };
}

const builder = new addonBuilder({
  id: "com.nguonc.stremio.addon",
  version: "3.6.0",
  name: "NguonC API",
  description: "Xem phim từ NguonC API trên Stremio",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  catalogs: [
    {
      type: "movie",
      id: "nguonc_movies",
      name: "NguonC - Phim Lẻ",
      extraSupported: ["skip"]
    },
    {
      type: "series",
      id: "nguonc_series",
      name: "NguonC - Phim Bộ",
      extraSupported: ["skip"]
    }
  ]
});

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    const skip = extra && typeof extra.skip === "number" ? extra.skip : 0;
    
    // Mỗi trang API NguồnC = 10 phim.
    // Stremio yêu cầu mỗi lượt skip là 100 phim để kích hoạt cuộn trang tiếp.
    const startPage = Math.floor(skip / 10) + 1;
    const PAGES_PER_BATCH = 10; // Tải 10 trang API = 100 phim

    let path = "/danh-sach/phim-le";
    if (id === "nguonc_series" || type === "series") {
      path = "/danh-sach/phim-bo";
    }

    // Tạo request song song cho 10 trang API
    const fetchPromises = [];
    for (let i = 0; i < PAGES_PER_BATCH; i++) {
      const pageNum = startPage + i;
      fetchPromises.push(
        fetchWithRetry(`${path}?page=${pageNum}`).catch(() => null)
      );
    }

    const responses = await Promise.all(fetchPromises);
    let allItems = [];

    responses.forEach(data => {
      if (data) {
        allItems = allItems.concat(extractItems(data));
      }
    });

    const metas = allItems.map(item => {
      const poster = item.poster_url || item.thumb_url || "";
      let fullPoster = poster;
      if (poster && !poster.startsWith("http")) {
        fullPoster = `https://phim.nguonc.com/uploads/movies/${poster.replace(/^\/+/, "")}`;
      }
      return {
        id: `nguonc:${item.slug}`,
        type: (id === "nguonc_movies" || type === "movie") ? "movie" : "series",
        name: item.name || item.title || "Phim NguồnC",
        poster: fullPoster,
        description: item.content || ""
      };
    });

    return { metas, cacheMaxAge: 300 };
  } catch (e) {
    console.error("[catalog] Error:", e.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  try {
    const { slug } = parseSlugAndIndex(id);
    if (!slug) return { meta: {} };

    const data = await fetchWithRetry(`/film/${encodeURIComponent(slug)}`);
    const movie = extractMovie(data);
    if (!movie) return { meta: {} };

    const episodes = movie.episodes || [];
    const videos = [];

    episodes.forEach((server, sIdx) => {
      const serverName = server.server_name || server.name || `NguồnC ${sIdx + 1}`;
      const items = server.items || server.server_data || [];
      items.forEach((ep, epIdx) => {
        const epName = ep.name || ep.slug || `Tập ${epIdx + 1}`;
        videos.push({
          id: `nguonc:${slug}:${sIdx}:${epIdx}`,
          title: `${serverName} - Tập ${epName}`,
          released: new Date().toISOString()
        });
      });
    });

    const poster = movie.poster_url || movie.thumb_url || "";
    let fullPoster = poster;
    if (poster && !poster.startsWith("http")) {
      fullPoster = `https://phim.nguonc.com/uploads/movies/${poster.replace(/^\/+/, "")}`;
    }

    return {
      meta: {
        id: `nguonc:${slug}`,
        type: type,
        name: movie.name || movie.title,
        poster: fullPoster,
        description: movie.content || "",
        videos: videos.length > 0 ? videos : [{
          id: `nguonc:${slug}:0:0`,
          title: "Tập Full"
        }]
      }
    };
  } catch (e) {
    console.error("[meta] Error:", e.message);
    return { meta: {} };
  }
});

builder.defineStreamHandler(async args => {
  try {
    const { slug, sIdx, epIdx } = parseSlugAndIndex(args.id);
    if (!slug) return { streams: [] };

    const key = `film:${slug}`;
    let payload = cached(key);
    if (!payload) payload = putCache(key, await fetchWithRetry(`/film/${encodeURIComponent(slug)}`));
    const movie = extractMovie(payload);
    if (!movie) return { streams: [] };

    const episodes = movie.episodes || [];
    const serverObj = episodes[sIdx] || episodes[0];
    if (!serverObj) return { streams: [] };

    const items = serverObj.items || serverObj.server_data || [];
    const epObj = items[epIdx] || items[0];
    if (!epObj) return { streams: [] };

    const embed = epObj.embed || epObj.link_embed || null;
    const m3u8Direct = epObj.link_m3u8 || epObj.m3u8 || null;
    const serverName = serverObj.server_name || "NguồnC";
    const epName = epObj.name || "Full";

    const streams = [];

    if (m3u8Direct) {
      streams.push({
        name: `NguonC • Direct`,
        title: `Phát trực tiếp • Tập ${epName}`,
        url: m3u8Direct
      });
    }

    if (embed) {
      try {
        const html = await fetchText(embed, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Referer": "https://phim.nguonc.com/"
          }
        });

        if (html) {
          const m3u8Match = html.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
          if (m3u8Match) {
            streams.push({
              name: `NguonC • ${serverName}`,
              title: `Phát HLS • Tập ${epName}`,
              url: m3u8Match[1]
            });
          }
        }
      } catch (err) {
        console.error("[stream] Parse error:", err.message);
      }

      streams.push({
        name: `NguonC • Web Player`,
        title: `Mở Trình Duyệt • Tập ${epName}`,
        externalUrl: embed
      });
    }

    return { streams, cacheMaxAge: 60 };
  } catch (e) {
    console.error("[stream] Error:", e.message);
    return { streams: [] };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });
