const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const PORT = Number(process.env.PORT || 7000);
const API_BASE = (process.env.NGUONC_API_BASE || "https://phim.nguonc.com/api").replace(/\/+$/, "");
const CACHE_SECONDS = Number(process.env.CACHE_SECONDS || 300);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15000);
const API_PAGE_SIZE = Number(process.env.API_PAGE_SIZE || 10);
const STREMIO_PAGE_SIZE = Number(process.env.STREMIO_PAGE_SIZE || 100);
const MAX_API_PAGES = Number(process.env.MAX_API_PAGES || 10);

const cache = new Map();

const GENRES = [
  "Hành Động", "Tình Cảm", "Hài Hước", "Cổ Trang", "Tâm Lý",
  "Kinh Dị", "Hoạt Hình", "Võ Thuật", "Phiêu Lưu", "Gia Đình",
  "Khoa Học Viễn Tưởng", "Trinh Thám", "Chiến Tranh", "Âm Nhạc"
];

const manifest = {
  id: "vn.nguonc.api",
  version: "3.0.0",
  name: "NguonC API",
  description: "NguonC catalog, tìm kiếm, metadata, tập phim và thử phát stream trực tiếp từ embed HTML công khai.",
  logo: "https://phim.nguonc.com/public/images/logo.png",
  resources: [
    "catalog",
    { name: "meta", types: ["movie", "series"], idPrefixes: ["nguonc:"] },
    { name: "stream", types: ["movie", "series"], idPrefixes: ["nguonc:"] }
  ],
  types: ["movie", "series"],
  idPrefixes: ["nguonc:"],
  catalogs: [
    { type: "movie", id: "nguonc-new", name: "NguonC • Mới cập nhật",
      extra: [{ name: "skip", isRequired: false }, { name: "search", isRequired: false }] },
    { type: "movie", id: "nguonc-dang-chieu", name: "NguonC • Đang chiếu",
      extra: [{ name: "skip", isRequired: false }, { name: "search", isRequired: false }] },
    { type: "movie", id: "nguonc-phim-bo", name: "NguonC • Phim bộ",
      extra: [{ name: "skip", isRequired: false }, { name: "search", isRequired: false }] },
    { type: "movie", id: "nguonc-phim-le", name: "NguonC • Phim lẻ",
      extra: [{ name: "skip", isRequired: false }, { name: "search", isRequired: false }] },
    { type: "movie", id: "nguonc-the-loai", name: "NguonC • Thể loại",
      genres: GENRES,
      extra: [{ name: "genre", isRequired: false }, { name: "skip", isRequired: false }, { name: "search", isRequired: false }] },
    { type: "movie", id: "nguonc-quoc-gia", name: "NguonC • Quốc gia",
      extra: [{ name: "genre", isRequired: false }, { name: "skip", isRequired: false }, { name: "search", isRequired: false }] },
    { type: "movie", id: "nguonc-search", name: "NguonC • Tìm kiếm",
      extra: [{ name: "search", isRequired: true }] }
  ]
};

const builder = new addonBuilder(manifest);

function safeText(value) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function slugify(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/đ/g, "d").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inferType(item) {
  const text = [item?.type, item?.category?.name, item?.name, item?.original_name]
    .filter(Boolean).join(" ").toLowerCase();
  return /phim\s*lẻ|movie/.test(text) ? "movie" : "series";
}

function extractMovie(payload) {
  return payload?.movie || payload?.data?.movie || payload?.data || null;
}

function extractItems(payload) {
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.films)) return payload.films;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      ...options,
      headers: {
        accept: options.accept || "*/*",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36",
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(path) {
  return JSON.parse(await fetchText(`${API_BASE}${path}`, { accept: "application/json" }));
}

async function fetchWithRetry(path) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await fetchJson(path); }
    catch (e) { last = e; if (i < 2) await new Promise(r => setTimeout(r, 500 * (i + 1))); }
  }
  throw last;
}

function cached(key) {
  const x = cache.get(key);
  if (!x || x.expires < Date.now()) return null;
  return x.value;
}
function putCache(key, value, seconds = CACHE_SECONDS) {
  cache.set(key, { value, expires: Date.now() + seconds * 1000 });
  return value;
}

function preview(item) {
  const slug = item?.slug || item?.id;
  if (!slug) return null;
  return {
    id: `nguonc:${slug}`,
    type: inferType(item),
    name: item?.name || item?.original_name || slug,
    poster: item?.poster_url || item?.thumb_url,
    posterShape: "poster",
    background: item?.thumb_url || item?.poster_url,
    description: safeText(item?.description),
    releaseInfo: item?.year ? String(item.year) : undefined
  };
}

function pagePath(id, extra, page) {
  switch (id) {
    case "nguonc-new": return `/films/phim-moi-cap-nhat?page=${page}`;
    case "nguonc-dang-chieu": return `/films/danh-sach/dang-chieu?page=${page}`;
    case "nguonc-phim-bo": return `/films/danh-sach/phim-bo?page=${page}`;
    case "nguonc-phim-le": return `/films/danh-sach/phim-le?page=${page}`;
    case "nguonc-the-loai":
      return extra?.genre ? `/films/the-loai/${encodeURIComponent(slugify(extra.genre))}?page=${page}` : `/films/phim-moi-cap-nhat?page=${page}`;
    case "nguonc-quoc-gia":
      return extra?.genre ? `/films/quoc-gia/${encodeURIComponent(slugify(extra.genre))}?page=${page}` : `/films/phim-moi-cap-nhat?page=${page}`;
    default: return `/films/phim-moi-cap-nhat?page=${page}`;
  }
}

builder.defineCatalogHandler(async args => {
  try {
    const extra = args.extra || {};
    const search = String(extra.search || "").trim();

    if (args.id === "nguonc-search" || search) {
      if (!search) return { metas: [] };
      const key = `search:${search}`;
      const hit = cached(key);
      const payload = hit || putCache(key, await fetchWithRetry(`/films/search?keyword=${encodeURIComponent(search)}`));
      return {
        metas: extractItems(payload).map(preview).filter(Boolean).slice(0, STREMIO_PAGE_SIZE),
        cacheMaxAge: CACHE_SECONDS
      };
    }

    const skip = Number(extra.skip || 0);
    const firstPage = Math.floor(skip / STREMIO_PAGE_SIZE) * Math.ceil(STREMIO_PAGE_SIZE / API_PAGE_SIZE) + 1;
    const pagesNeeded = Math.ceil(STREMIO_PAGE_SIZE / API_PAGE_SIZE);
    const metas = [], seen = new Set();

    for (let i = 0; i < Math.min(pagesNeeded, MAX_API_PAGES); i++) {
      const page = firstPage + i;
      const key = `catalog:${args.id}:${JSON.stringify(extra)}:${page}`;
      let payload = cached(key);
      if (!payload) payload = putCache(key, await fetchWithRetry(pagePath(args.id, extra, page)));
      for (const item of extractItems(payload)) {
        const m = preview(item);
        if (!m || seen.has(m.id)) continue;
        seen.add(m.id);
        metas.push(m);
        if (metas.length >= STREMIO_PAGE_SIZE) break;
      }
      if (metas.length >= STREMIO_PAGE_SIZE) break;
    }

    return { metas, cacheMaxAge: CACHE_SECONDS, staleRevalidate: 60, staleError: 3600 };
  } catch (e) {
    console.error("[catalog]", e.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async args => {
  try {
    const slug = String(args.id || "").replace(/^nguonc:/, "").split(":ep:")[0];
    const key = `film:${slug}`;
    let payload = cached(key);
    if (!payload) payload = putCache(key, await fetchWithRetry(`/film/${encodeURIComponent(slug)}`));
    const movie = extractMovie(payload);
    if (!movie) return { meta: null };

    const categories = movie.category && typeof movie.category === "object"
      ? Object.values(movie.category).flatMap(g => g?.list || []) : [];

    const meta = {
      id: `nguonc:${movie.slug || slug}`,
      type: inferType(movie),
      name: movie.name || movie.original_name || slug,
      poster: movie.poster_url || movie.thumb_url,
      posterShape: "poster",
      background: movie.thumb_url || movie.poster_url,
      description: safeText(movie.description),
      director: movie.director ? [movie.director] : [],
      cast: typeof movie.casts === "string" ? movie.casts.split(",").map(x => x.trim()).filter(Boolean) : [],
      genres: categories.map(x => x?.name).filter(Boolean),
      releaseInfo: movie.created ? String(movie.created).slice(0, 4) : undefined,
      videos: []
    };

    for (const server of (Array.isArray(movie.episodes) ? movie.episodes : [])) {
      const serverName = server?.server_name || "NguonC";
      for (const ep of (Array.isArray(server?.items) ? server.items : [])) {
        const name = String(ep?.name || ep?.slug || "");
        if (!name) continue;
        const n = Number.parseInt(name.replace(/\D/g, ""), 10);
        meta.videos.push({
          id: `nguonc:${movie.slug || slug}:ep:${encodeURIComponent(serverName)}:${encodeURIComponent(name)}`,
          title: `Tập ${name} • ${serverName}`,
          season: 1,
          episode: Number.isFinite(n) ? n : meta.videos.length + 1,
          thumbnail: movie.thumb_url || movie.poster_url,
          overview: serverName
        });
      }
    }
    meta.videos.sort((a,b) => a.episode - b.episode || a.title.localeCompare(b.title));
    return { meta, cacheMaxAge: CACHE_SECONDS };
  } catch (e) {
    console.error("[meta]", e.message);
    return { meta: null };
  }
});

/*
 * Safe/direct extraction:
 * We fetch only the public HTML returned by the embed URL and look for
 * ordinary media URLs already present in that response (.m3u8/.mp4).
 * We do not execute obfuscated JavaScript, crack tokens, bypass access
 * controls, or proxy the media.
 */
function absolutize(raw, base) {
  try { return new URL(raw, base).href; } catch { return null; }
}

function extractDirectMedia(html, baseUrl) {
  const candidates = new Set();
  const patterns = [
    /https?:\/\/[^"'\\\s<>]+?\.(?:m3u8|mp4)(?:\?[^"'\\\s<>]*)?/gi,
    /(?:src|file|source|url|playlist)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/gi,
    /["']([^"']+\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/gi
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const raw = m[1] || m[0];
      const u = absolutize(raw.replace(/\\u0026/g, "&").replace(/\\\//g, "/"), baseUrl);
      if (u) candidates.add(u);
    }
  }
  return [...candidates];
}

function parseEmbedUrlFromEpisode(movie, serverName, wantedEpisode) {
  for (const server of (Array.isArray(movie?.episodes) ? movie.episodes : [])) {
    const current = server?.server_name || "NguonC";
    if (current !== serverName) continue;
    for (const ep of (Array.isArray(server?.items) ? server.items : [])) {
      if (String(ep?.name || ep?.slug || "") === wantedEpisode) return ep?.embed || null;
    }
  }
  return null;
}

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
      html = await fetchText(embed, {
        headers: {
          referer: "https://phim.nguonc.com/",
          origin: "https://phim.nguonc.com"
        }
      });
      putCache(embedKey, html, 60);
    }

    const media = extractDirectMedia(html, embed);

    if (media.length) {
      return {
        streams: media.map((url, i) => ({
          name: `NguonC • ${serverName}`,
          title: media.length > 1 ? `Stream ${i + 1} • ${serverName}` : `Phát trực tiếp • ${serverName}`,
          url,
          behaviorHints: {
            bingeGroup: `nguonc-${serverName}`,
            videoSize: "HD"
          }
        })),
        cacheMaxAge: 60
      };
    }

    // Fallback: public embed/player works in a browser, but the HTML did not
    // expose a direct media URL. Open the player externally rather than
    // pretending the HTML page itself is a video stream.
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
console.log(`NguonC Stremio addon v3 running at http://127.0.0.1:${PORT}/manifest.json`);
