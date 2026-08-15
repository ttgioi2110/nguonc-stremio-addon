const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const PORT = Number(process.env.PORT || 7000);
const API_BASE = (process.env.NGUONC_API_BASE || "https://phim.nguonc.com/api").replace(/\/+$/, "");
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
  const url = `${API_BASE}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
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

function parseEmbedUrlFromEpisode(movie, serverName, wantedEpisode) {
  const episodes = movie?.episodes || [];
  for (const s of episodes) {
    const sName = s.server_name || s.server_data?.[0]?.name || "NguồnC";
    if (serverName && sName !== serverName) continue;
    const items = s.items || s.server_data || [];
    for (const ep of items) {
      const epName = String(ep.name || ep.slug || "").trim();
      if (epName === String(wantedEpisode).trim()) {
        return ep.embed || ep.link_embed || ep.link_m3u8 || null;
      }
    }
  }
  return null;
}

const builder = new addonBuilder({
  id: "com.nguonc.stremio.addon",
  version: "3.0.1",
  name: "NguonC API",
  description: "Xem phim từ NguonC API trên Stremio",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  catalogs: [
    { type: "movie", id: "nguonc_movies", name: "NguonC - Phim Lẻ" },
    { type: "series", id: "nguonc_series", name: "NguonC - Phim Bộ" }
  ]
});

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    const skip = extra && typeof extra.skip === "number" ? extra.skip : 0;
    const page = Math.floor(skip / 20) + 1;

    let path = "/danh-sach/phim-le";
    if (id === "nguonc_series" || type === "series") {
      path = "/danh-sach/phim-bo";
    }

    const endpoint = `${path}?page=${page}`;
    const data = await fetchWithRetry(endpoint);
    const items = extractItems(data);

    const metas = items.map(item => {
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

    return { metas };
  } catch (e) {
    console.error("[catalog] Error:", e.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  try {
    const slug = id.replace(/^nguonc:/, "");
    const data = await fetchWithRetry(`/film/${encodeURIComponent(slug)}`);
    const movie = extractMovie(data);
    if (!movie) return { meta: {} };

    const episodes = movie.episodes || [];
    const videos = [];

    episodes.forEach(server => {
      const serverName = server.server_name || "NguồnC";
      const items = server.items || server.server_data || [];
      items.forEach(ep => {
        videos.push({
          id: `nguonc:${slug}:ep:${encodeURIComponent(serverName)}:${encodeURIComponent(ep.name)}`,
          title: `${serverName} - Tập ${ep.name}`,
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
        videos: videos
      }
    };
  } catch (e) {
    console.error("[meta]", e.message);
    return { meta: {} };
  }
});

builder.defineStreamHandler(async args => {
  try {
    const raw = String(args.id || "").replace(/^nguonc:/, "");
    const split = raw.split(":ep:");
    const slug = split[0];
    const rest = split.slice(1).join(":ep:");
    const pieces = rest.split(":");
    const serverName = decodeURIComponent(pieces[0] || "");
    const wantedEpisode = decodeURIComponent(pieces.slice(1).join(":") || "");
    if (!slug || !serverName || !wantedEpisode) return { streams: [] };

    const key = `film:${slug}`;
    let payload = cached(key);
    if (!payload) payload = putCache(key, await fetchWithRetry(`/film/${encodeURIComponent(slug)}`));
    const movie = extractMovie(payload);
    const embed = parseEmbedUrlFromEpisode(movie, serverName, wantedEpisode);
    if (!embed) return { streams: [] };

    const embedKey = `embed:${embed}`;
    let html = cached(embedKey);
    if (!html) {
      try {
        html = await fetchText(embed, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://phim.nguonc.com/",
            "Origin": "https://phim.nguonc.com"
          }
        });
        if (html) putCache(embedKey, html, 60);
      } catch (err) {
        console.error("[stream] Fetch embed error:", err.message);
      }
    }

    let directProxyUrl = null;
    if (html) {
      const hashMatch = html.match(/hash\s*:\s*["']([^"']+)["']/i) || html.match(/h\s*:\s*["']([^"']+)["']/i);
      const keyMatch = html.match(/key\s*:\s*["']([^"']+)["']/i) || html.match(/t\s*:\s*["']([^"']+)["']/i);
      
      const hash = hashMatch ? hashMatch[1] : null;
      const keyVal = keyMatch ? keyMatch[1] : null;

      if (hash && keyVal) {
        const domain = embed.split('/')[2];
        const payloadBase64 = Buffer.from(JSON.stringify({ h: hash, t: keyVal })).toString('base64');
        const targetM3u8 = `https://${domain}/${payloadBase64}.m3u8`;
        
        directProxyUrl = `https://m3u8-proxy-w1lo.onrender.com/proxy-m3u8?url=${encodeURIComponent(targetM3u8)}&referer=${encodeURIComponent(embed)}`;
      }
    }

    if (directProxyUrl) {
      return {
        streams: [{
          name: `NguonC • ${serverName}`,
          title: `Phát trực tiếp • Tập ${wantedEpisode}`,
          url: directProxyUrl,
          behaviorHints: {
            bingeGroup: `nguonc-${serverName}`,
            videoSize: "HD"
          }
        }],
        cacheMaxAge: 60
      };
    }

    return {
      streams: [{
        name: `NguonC • ${serverName}`,
        title: `Mở player • Tập ${wantedEpisode}`,
        externalUrl: embed,
        behaviorHints: { bingeGroup: `nguonc-${serverName}` }
      }],
      cacheMaxAge: 60
    };
  } catch (e) {
    console.error("[stream]", e.message);
    return { streams: [] };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });
