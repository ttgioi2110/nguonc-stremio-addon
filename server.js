const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const PORT = Number(process.env.PORT || 7000);
const CACHE_SECONDS = Number(process.env.CACHE_SECONDS || 600);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 10000);

// Stremio dùng skip theo block 100.
// NguồnC hiện trả khoảng 10 item / page.
// => Mỗi request cần lấy 10 page = khoảng 100 phim.
const STREMIO_PAGE_SIZE = 100;
const NGUONC_PAGE_SIZE = 10;
const NGUONC_PAGES_PER_BATCH =
  Math.ceil(STREMIO_PAGE_SIZE / NGUONC_PAGE_SIZE);

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
  cache.set(key, {
    data,
    expiresAt: Date.now() + ttlSec * 1000
  });

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

    const timeout = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          ...(options.headers || {})
        }
      });

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

  const timeout = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function extractMovie(payload) {
  if (!payload) return null;

  if (payload.movie) return payload.movie;
  if (payload.item) return payload.item;

  if (payload.data && payload.data.item) {
    return payload.data.item;
  }

  if (payload.data && payload.data.movie) {
    return payload.data.movie;
  }

  return payload;
}

function extractItems(payload) {
  if (!payload) return [];

  if (Array.isArray(payload.items)) {
    return payload.items;
  }

  if (payload.data && Array.isArray(payload.data.items)) {
    return payload.data.items;
  }

  if (payload.data && Array.isArray(payload.data)) {
    return payload.data;
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  return [];
}

function parseSlugAndIndex(rawId) {
  const clean = String(rawId || "").replace(/^nguonc:/, "");

  const parts = clean.split(":");

  return {
    slug: parts[0],
    sIdx: Number.isFinite(parseInt(parts[1], 10))
      ? parseInt(parts[1], 10)
      : 0,
    epIdx: Number.isFinite(parseInt(parts[2], 10))
      ? parseInt(parts[2], 10)
      : 0
  };
}

function normalizeSkip(value) {
  const n = parseInt(value, 10);

  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }

  return n;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function getPoster(item) {
  const poster = item.poster_url || item.thumb_url || "";

  if (!poster) return "";

  if (poster.startsWith("http")) {
    return poster;
  }

  return `https://phim.nguonc.com/uploads/movies/${String(poster).replace(
    /^\/+/,
    ""
  )}`;
}

function getGenres(item) {
  const result = [];

  const candidates = [
    item.categories,
    item.category,
    item.genres,
    item.genre,
    item.the_loai,
    item.theloai
  ];

  for (const value of candidates) {
    if (!value) continue;

    if (Array.isArray(value)) {
      for (const x of value) {
        if (!x) continue;

        if (typeof x === "string") {
          result.push(x);
        } else if (x.name) {
          result.push(x.name);
        } else if (x.title) {
          result.push(x.title);
        } else if (x.slug) {
          result.push(x.slug);
        }
      }
    } else if (typeof value === "string") {
      result.push(value);
    } else if (typeof value === "object") {
      if (value.name) result.push(value.name);
      else if (value.title) result.push(value.title);
      else if (value.slug) result.push(value.slug);
    }
  }

  return [...new Set(result)];
}

/*
 * Danh sách thể loại hiển thị cho Stremio.
 * Tên bên trái là tên hiện trên Stremio.
 * Tên bên phải là chuỗi sẽ được dùng để lọc dữ liệu.
 */
const GENRES = [
  { name: "Hành Động", value: "Hành Động" },
  { name: "Phiêu Lưu", value: "Phiêu Lưu" },
  { name: "Hoạt Hình", value: "Hoạt Hình" },
  { name: "Hài", value: "Hài" },
  { name: "Hình Sự", value: "Hình Sự" },
  { name: "Chính Kịch", value: "Chính Kịch" },
  { name: "Kinh Dị", value: "Kinh Dị" },
  { name: "Tình Cảm", value: "Tình Cảm" },
  { name: "Cổ Trang", value: "Cổ Trang" },
  { name: "Viễn Tưởng", value: "Viễn Tưởng" }
];

const builder = new addonBuilder({
  id: "com.nguonc.stremio.addon.v44",
  version: "4.4.0",
  name: "NguonC API (v4.4)",
  description:
    "Xem phim từ NguonC API trên Stremio - phân trang 100 item + lọc thể loại",

  resources: ["catalog", "meta", "stream"],

  types: ["movie", "series"],

  catalogs: [
    {
      type: "movie",
      id: "nguonc_movies",
      name: "NguonC - Phim Lẻ",

      extra: [
        {
          name: "skip",
          isRequired: false
        }
      ],

      extraSupported: ["skip"]
    },

    {
      type: "series",
      id: "nguonc_series",
      name: "NguonC - Phim Bộ",

      extra: [
        {
          name: "skip",
          isRequired: false
        }
      ],

      extraSupported: ["skip"]
    },

    {
      type: "movie",
      id: "nguonc_genres",
      name: "NguonC - Thể Loại",

      genres: GENRES.map(x => x.value),

      extra: [
        {
          name: "genre",
          isRequired: false,
          options: GENRES.map(x => x.value),
          optionsLimit: 1
        },

        {
          name: "skip",
          isRequired: false
        }
      ],

      extraSupported: ["genre", "skip"]
    },

    {
      type: "series",
      id: "nguonc_genres_series",
      name: "NguonC - Thể Loại Phim Bộ",

      genres: GENRES.map(x => x.value),

      extra: [
        {
          name: "genre",
          isRequired: false,
          options: GENRES.map(x => x.value),
          optionsLimit: 1
        },

        {
          name: "skip",
          isRequired: false
        }
      ],

      extraSupported: ["genre", "skip"]
    }
  ]
});

/*
 * Lấy một block 100 phim bắt đầu từ skip.
 *
 * Ví dụ:
 * skip = 0
 * => API page 1..10
 *
 * skip = 100
 * => API page 11..20
 *
 * skip = 200
 * => API page 21..30
 */
async function fetchCatalogBlock(type, skip) {
  const cacheKey = `catalog-block:${type}:${skip}`;

  const hit = cached(cacheKey);

  if (hit) {
    return hit;
  }

  const path =
    type === "series"
      ? "/danh-sach/phim-bo"
      : "/danh-sach/phim-le";

  const startPage =
    Math.floor(skip / NGUONC_PAGE_SIZE) + 1;

  const promises = [];

  for (let i = 0; i < NGUONC_PAGES_PER_BATCH; i++) {
    const pageNum = startPage + i;

    promises.push(
      fetchWithRetry(
        `${path}?page=${pageNum}`
      ).catch(err => {
        console.error(
          `[catalog] page ${pageNum} failed:`,
          err.message
        );

        return null;
      })
    );
  }

  const responses = await Promise.all(promises);

  let allItems = [];

  for (const response of responses) {
    if (!response) continue;

    const items = extractItems(response);

    allItems = allItems.concat(items);
  }

  // Chống trùng slug giữa các response.
  const unique = [];
  const seen = new Set();

  for (const item of allItems) {
    const key =
      item.slug ||
      item.id ||
      item._id ||
      item.name ||
      JSON.stringify(item);

    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(item);
  }

  return putCache(
    cacheKey,
    unique,
    CACHE_SECONDS
  );
}

function itemToMeta(item, type) {
  return {
    id: `nguonc:${item.slug}`,
    type,
    name:
      item.name ||
      item.title ||
      "Phim NguồnC",

    poster: getPoster(item),

    description:
      item.content ||
      item.description ||
      "",

    genres: getGenres(item)
  };
}

builder.defineCatalogHandler(async args => {
  try {
    const {
      type,
      id,
      extra = {}
    } = args;

    /*
     * Stremio gửi skip theo chuẩn 100.
     * Có thể là string hoặc number => normalize.
     */
    const skip = normalizeSkip(extra.skip);

    const genre =
      typeof extra.genre === "string"
        ? extra.genre.trim()
        : "";

    /*
     * Xác định catalog đang gọi.
     */
    let sourceType = type;

    if (id === "nguonc_movies") {
      sourceType = "movie";
    }

    if (id === "nguonc_series") {
      sourceType = "series";
    }

    if (id === "nguonc_genres") {
      sourceType = "movie";
    }

    if (id === "nguonc_genres_series") {
      sourceType = "series";
    }

    /*
     * Catalog bình thường:
     *
     * Phim Lẻ
     * Phim Bộ
     */
    if (
      id === "nguonc_movies" ||
      id === "nguonc_series"
    ) {
      const rawItems =
        await fetchCatalogBlock(
          sourceType,
          skip
        );

      const metas = rawItems.map(item =>
        itemToMeta(item, sourceType)
      );

      return {
        metas,
        cacheMaxAge: 600,
        staleRevalidate: 3600
      };
    }

    /*
     * Catalog thể loại.
     *
     * Vì chưa phụ thuộc endpoint genre riêng của NguonC,
     * chúng ta lọc các phim đã lấy từ danh sách tương ứng.
     */
    if (
      id === "nguonc_genres" ||
      id === "nguonc_genres_series"
    ) {
      const rawItems =
        await fetchCatalogBlock(
          sourceType,
          skip
        );

      let filtered = rawItems;

      if (genre) {
        const target = normalizeText(genre);

        filtered = rawItems.filter(item => {
          const genres = getGenres(item);

          return genres.some(g =>
            normalizeText(g).includes(target)
          );
        });
      }

      const metas = filtered.map(item =>
        itemToMeta(item, sourceType)
      );

      return {
        metas,
        cacheMaxAge: 600,
        staleRevalidate: 3600
      };
    }

    return {
      metas: []
    };
  } catch (e) {
    console.error(
      "[catalog] Error:",
      e.message
    );

    return {
      metas: []
    };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  try {
    const { slug } =
      parseSlugAndIndex(id);

    if (
      !slug ||
      slug === "tmdb" ||
      slug.startsWith("tt")
    ) {
      return {
        meta: {}
      };
    }

    const data =
      await fetchWithRetry(
        `/film/${encodeURIComponent(slug)}`
      );

    const movie =
      extractMovie(data);

    if (!movie) {
      return {
        meta: {}
      };
    }

    const episodes =
      movie.episodes || [];

    const videos = [];

    episodes.forEach(
      (server, sIdx) => {
        const serverName =
          server.server_name ||
          server.name ||
          `NguồnC ${sIdx + 1}`;

        const items =
          server.items ||
          server.server_data ||
          [];

        items.forEach(
          (ep, epIdx) => {
            const epName =
              ep.name ||
              ep.slug ||
              `Tập ${epIdx + 1}`;

            videos.push({
              id:
                `nguonc:${slug}:${sIdx}:${epIdx}`,

              title:
                `${serverName} - Tập ${epName}`,

              released:
                new Date().toISOString()
            });
          }
        );
      }
    );

    const poster =
      movie.poster_url ||
      movie.thumb_url ||
      "";

    let fullPoster =
      poster;

    if (
      poster &&
      !poster.startsWith("http")
    ) {
      fullPoster =
        `https://phim.nguonc.com/uploads/movies/${poster.replace(
          /^\/+/,
          ""
        )}`;
    }

    return {
      meta: {
        id: `nguonc:${slug}`,
        type,

        name:
          movie.name ||
          movie.title,

        poster:
          fullPoster,

        description:
          movie.content ||
          "",

        genres:
          getGenres(movie),

        videos:
          videos.length > 0
            ? videos
            : [
                {
                  id:
                    `nguonc:${slug}:0:0`,

                  title:
                    "Tập Full"
                }
              ]
      }
    };
  } catch (e) {
    console.error(
      "[meta] Error:",
      e.message
    );

    return {
      meta: {}
    };
  }
});

builder.defineStreamHandler(async args => {
  try {
    const {
      slug,
      sIdx,
      epIdx
    } = parseSlugAndIndex(args.id);

    if (
      !slug ||
      slug === "tmdb" ||
      slug.startsWith("tt")
    ) {
      return {
        streams: []
      };
    }

    const key =
      `film:${slug}`;

    let payload =
      cached(key);

    if (!payload) {
      payload =
        putCache(
          key,
          await fetchWithRetry(
            `/film/${encodeURIComponent(slug)}`
          )
        );
    }

    const movie =
      extractMovie(payload);

    if (!movie) {
      return {
        streams: []
      };
    }

    const episodes =
      movie.episodes || [];

    const serverObj =
      episodes[sIdx] ||
      episodes[0];

    if (!serverObj) {
      return {
        streams: []
      };
    }

    const items =
      serverObj.items ||
      serverObj.server_data ||
      [];

    const epObj =
      items[epIdx] ||
      items[0];

    if (!epObj) {
      return {
        streams: []
      };
    }

    const embed =
      epObj.embed ||
      epObj.link_embed ||
      null;

    const m3u8Direct =
      epObj.link_m3u8 ||
      epObj.m3u8 ||
      null;

    const serverName =
      serverObj.server_name ||
      "NguồnC";

    const epName =
      epObj.name ||
      "Full";

    const streams = [];

    /*
     * Direct M3U8
     */
    if (m3u8Direct) {
      streams.push({
        name:
          "NguonC • Direct",

        title:
          `Phát trực tiếp • Tập ${epName}`,

        url:
          m3u8Direct
      });
    }

    /*
     * Embed -> thử lấy M3U8
     */
    if (embed) {
      try {
        const html =
          await fetchText(
            embed,
            {
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                "Referer":
                  "https://phim.nguonc.com/"
              }
            }
          );

        if (html) {
          const m3u8Match =
            html.match(
              /(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i
            );

          if (m3u8Match) {
            streams.push({
              name:
                `NguonC • ${serverName}`,

              title:
                `Phát HLS • Tập ${epName}`,

              url:
                m3u8Match[1]
            });
          }
        }
      } catch (err) {
        console.error(
          "[stream] Parse error:",
          err.message
        );
      }

      /*
       * Giữ web player fallback
       */
      streams.push({
        name:
          "NguonC • Web Player",

        title:
          `Mở Trình Duyệt • Tập ${epName}`,

        externalUrl:
          embed
      });
    }

    return {
      streams,
      cacheMaxAge: 60
    };
  } catch (e) {
    console.error(
      "[stream] Error:",
      e.message
    );

    return {
      streams: []
    };
  }
});

serveHTTP(
  builder.getInterface(),
  {
    port: PORT
  }
);
