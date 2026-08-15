const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const PORT = Number(process.env.PORT || 7000);
const CACHE_SECONDS = Number(process.env.CACHE_SECONDS || 600);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15000);

const cache = new Map();

/*
 * ============================================================
 * CONFIG
 * ============================================================
 */

const STREMIO_PAGE_SIZE = 100;

// NguồnC thường trả khoảng 10 phim / page
const NGUONC_ITEMS_PER_PAGE = 10;

// Mỗi lần Stremio yêu cầu 100 phim -> lấy 10 page NguồnC
const NGUONC_PAGES_PER_BATCH = Math.ceil(
  STREMIO_PAGE_SIZE / NGUONC_ITEMS_PER_PAGE
);

/*
 * Các thể loại dùng trong Stremio.
 *
 * value = tên hiển thị
 * slug  = slug trên URL NguồnC
 */
const GENRES = [
  {
    value: "Hành Động",
    slug: "hanh-dong"
  },
  {
    value: "Phiêu Lưu",
    slug: "phieu-luu"
  },
  {
    value: "Hoạt Hình",
    slug: "hoat-hinh"
  },
  {
    value: "Hài",
    slug: "hai"
  },
  {
    value: "Hình Sự",
    slug: "hinh-su"
  },
  {
    value: "Chính Kịch",
    slug: "chinh-kich"
  },
  {
    value: "Kinh Dị",
    slug: "kinh-di"
  },
  {
    value: "Tình Cảm",
    slug: "tinh-cam"
  },
  {
    value: "Cổ Trang",
    slug: "co-trang"
  },
  {
    value: "Viễn Tưởng",
    slug: "vien-tuong"
  }
];

/*
 * ============================================================
 * CACHE
 * ============================================================
 */

function cached(key) {
  const hit = cache.get(key);

  if (!hit) {
    return null;
  }

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

/*
 * ============================================================
 * HTTP
 * ============================================================
 */

function buildHeaders(extra = {}) {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36",

    "Accept":
      "application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

    ...extra
  };
}

async function fetchUrl(url, options = {}) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: buildHeaders(options.headers || {})
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetchUrl(url, options);
  return await res.json();
}

async function fetchHtml(url, options = {}) {
  const res = await fetchUrl(url, options);
  return await res.text();
}

/*
 * API hiện tại của bạn.
 */
async function fetchWithRetry(path, options = {}) {
  const candidates = [
    `https://phim.nguonc.com/api/films${path}`,
    `https://phim.nguonc.com/api${path}`
  ];

  let lastErr = null;

  for (const url of candidates) {
    try {
      return await fetchJson(url, options);
    } catch (err) {
      lastErr = err;

      console.error(
        `[api] ${url} -> ${err.message}`
      );
    }
  }

  throw lastErr || new Error("API request failed");
}

/*
 * ============================================================
 * RESPONSE PARSER
 * ============================================================
 */

function extractMovie(payload) {
  if (!payload) {
    return null;
  }

  if (payload.movie) {
    return payload.movie;
  }

  if (payload.item) {
    return payload.item;
  }

  if (payload.data && payload.data.item) {
    return payload.data.item;
  }

  if (payload.data && payload.data.movie) {
    return payload.data.movie;
  }

  return payload;
}

function extractItems(payload) {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload.items)) {
    return payload.items;
  }

  if (
    payload.data &&
    Array.isArray(payload.data.items)
  ) {
    return payload.data.items;
  }

  if (
    payload.data &&
    Array.isArray(payload.data)
  ) {
    return payload.data;
  }

  if (Array.isArray(payload.results)) {
    return payload.results;
  }

  if (
    payload.data &&
    Array.isArray(payload.data.results)
  ) {
    return payload.data.results;
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  return [];
}

/*
 * ============================================================
 * UTILITIES
 * ============================================================
 */

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

function makeAbsoluteUrl(url) {
  if (!url) {
    return "";
  }

  const value = String(url).trim();

  if (value.startsWith("http://")) {
    return value;
  }

  if (value.startsWith("https://")) {
    return value;
  }

  if (value.startsWith("//")) {
    return `https:${value}`;
  }

  if (value.startsWith("/")) {
    return `https://phim.nguonc.com${value}`;
  }

  return value;
}

function getPoster(item) {
  if (!item) {
    return "";
  }

  const poster =
    item.poster_url ||
    item.thumb_url ||
    item.poster ||
    item.thumbnail ||
    "";

  if (!poster) {
    return "";
  }

  if (
    String(poster).startsWith("http://") ||
    String(poster).startsWith("https://")
  ) {
    return poster;
  }

  if (String(poster).startsWith("//")) {
    return `https:${poster}`;
  }

  return `https://phim.nguonc.com/uploads/movies/${String(
    poster
  ).replace(/^\/+/, "")}`;
}

function getSlug(item) {
  if (!item) {
    return "";
  }

  return (
    item.slug ||
    item.id ||
    item.movie_slug ||
    ""
  );
}

function getGenres(item) {
  const result = [];

  if (!item) {
    return result;
  }

  const candidates = [
    item.categories,
    item.category,
    item.genres,
    item.genre,
    item.the_loai,
    item.theloai
  ];

  for (const value of candidates) {
    if (!value) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const x of value) {
        if (!x) {
          continue;
        }

        if (typeof x === "string") {
          result.push(x);
          continue;
        }

        if (x.name) {
          result.push(x.name);
          continue;
        }

        if (x.title) {
          result.push(x.title);
          continue;
        }

        if (x.slug) {
          result.push(x.slug);
        }
      }

      continue;
    }

    if (typeof value === "string") {
      result.push(value);
      continue;
    }

    if (typeof value === "object") {
      if (value.name) {
        result.push(value.name);
      } else if (value.title) {
        result.push(value.title);
      } else if (value.slug) {
        result.push(value.slug);
      }
    }
  }

  return [...new Set(result)];
}

function uniqueItems(items) {
  const result = [];
  const seen = new Set();

  for (const item of items) {
    const key =
      getSlug(item) ||
      item.name ||
      item.title;

    if (!key) {
      continue;
    }

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function itemToMeta(item, type) {
  return {
    id: `nguonc:${getSlug(item)}`,

    type,

    name:
      item.name ||
      item.title ||
      "Phim NguồnC",

    poster:
      getPoster(item),

    description:
      item.content ||
      item.description ||
      "",

    genres:
      getGenres(item)
  };
}

/*
 * ============================================================
 * CATALOG: PHIM LẺ / PHIM BỘ
 * ============================================================
 */

async function fetchCatalogBlock(
  type,
  skip
) {
  const cacheKey =
    `catalog:${type}:${skip}`;

  const cacheHit =
    cached(cacheKey);

  if (cacheHit) {
    return cacheHit;
  }

  const path =
    type === "series"
      ? "/danh-sach/phim-bo"
      : "/danh-sach/phim-le";

  /*
   * skip 0   -> page 1..10
   * skip 100 -> page 11..20
   * skip 200 -> page 21..30
   */

  const startPage =
    Math.floor(
      skip / NGUONC_ITEMS_PER_PAGE
    ) + 1;

  const promises = [];

  for (
    let i = 0;
    i < NGUONC_PAGES_PER_BATCH;
    i++
  ) {
    const page =
      startPage + i;

    promises.push(
      fetchWithRetry(
        `${path}?page=${page}`
      ).catch(err => {
        console.error(
          `[catalog] ${path} page ${page}: ${err.message}`
        );

        return null;
      })
    );
  }

  const responses =
    await Promise.all(
      promises
    );

  let allItems = [];

  for (const response of responses) {
    if (!response) {
      continue;
    }

    allItems =
      allItems.concat(
        extractItems(response)
      );
  }

  const result =
    uniqueItems(allItems);

  return putCache(
    cacheKey,
    result,
    CACHE_SECONDS
  );
}

/*
 * ============================================================
 * GENRE
 * ============================================================
 */

/*
 * Đây là URL thật mà bạn đã phát hiện:
 *
 * https://phim.nguonc.com/the-loai/hanh-dong?load=1&sort_field=new&cats[1]=&cats[6]=7&cats[25]=&cats[47]=
 *
 * Vì NguồnC có thể thay đổi cấu trúc API, addon sẽ thử:
 *
 * 1. API JSON
 * 2. Route web HTML thật
 *
 * Không cần bạn sửa endpoint thủ công.
 */

function getGenreInfo(genreName) {
  const normalized =
    normalizeText(genreName);

  return GENRES.find(
    x =>
      normalizeText(x.value) ===
      normalized
  );
}

async function fetchGenreJson(
  genreSlug,
  page
) {
  const candidates = [
    `/the-loai/${genreSlug}?page=${page}`,

    `/the-loai/${genreSlug}?load=1&sort_field=new&page=${page}`,

    `/films/the-loai/${genreSlug}?page=${page}`,

    `/films/the-loai/${genreSlug}?load=1&sort_field=new&page=${page}`,

    `/api/the-loai/${genreSlug}?page=${page}`,

    `/api/the-loai/${genreSlug}?load=1&sort_field=new&page=${page}`,

    `/api/films/the-loai/${genreSlug}?page=${page}`,

    `/api/films/the-loai/${genreSlug}?load=1&sort_field=new&page=${page}`
  ];

  for (const path of candidates) {
    try {
      const data =
        await fetchWithRetry(
          path
        );

      const items =
        extractItems(data);

      if (items.length > 0) {
        console.log(
          `[genre-api] OK ${path} -> ${items.length}`
        );

        return {
          items,
          source: "json",
          path
        };
      }
    } catch (err) {
      console.log(
        `[genre-api] ${path} -> ${err.message}`
      );
    }
  }

  return null;
}

/*
 * ============================================================
 * HTML GENRE PARSER
 * ============================================================
 *
 * Nếu route web không có API JSON riêng,
 * chúng ta đọc trang /the-loai/... trực tiếp
 * và cố lấy link phim + poster + tên phim.
 */

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseGenreHtml(html) {
  const result = [];

  /*
   * Bắt các link phim dạng:
   *
   * /phim/ten-phim
   *
   * hoặc
   *
   * https://phim.nguonc.com/phim/ten-phim
   */

  const hrefRegex =
    /href\s*=\s*["']([^"']*\/phim\/[^"']+)["']/gi;

  let match;

  while (
    (match = hrefRegex.exec(html)) !== null
  ) {
    const href =
      decodeHtml(match[1]);

    const absolute =
      makeAbsoluteUrl(href);

    const slugMatch =
      absolute.match(
        /\/phim\/([^/?#]+)/i
      );

    if (!slugMatch) {
      continue;
    }

    const slug =
      decodeURIComponent(
        slugMatch[1]
      );

    /*
     * Chỉ lấy phần HTML xung quanh link.
     * Thông thường card phim nằm trong khoảng
     * vài nghìn ký tự.
     */

    const start =
      Math.max(
        0,
        match.index - 1500
      );

    const end =
      Math.min(
        html.length,
        match.index + 3500
      );

    const card =
      html.substring(
        start,
        end
      );

    /*
     * Tìm ảnh gần card.
     */

    let poster = "";

    const imgMatches =
      card.match(
        /(?:src|data-src|data-lazy-src)\s*=\s*["']([^"']+)["']/gi
      );

    if (imgMatches) {
      for (
        const imgAttr of imgMatches
      ) {
        const pm =
          imgAttr.match(
            /["']([^"']+)["']/
          );

        if (!pm) {
          continue;
        }

        const candidate =
          pm[1];

        if (
          /\.(jpg|jpeg|png|webp)/i.test(
            candidate
          )
        ) {
          poster =
            makeAbsoluteUrl(
              candidate
            );

          break;
        }
      }
    }

    /*
     * Lấy title.
     */

    let name =
      slug.replace(
        /-/g,
        " "
      );

    const titlePatterns = [
      /title\s*=\s*["']([^"']+)["']/i,

      /alt\s*=\s*["']([^"']+)["']/i,

      /<h[1-6][^>]*>\s*([^<]+)\s*<\/h[1-6]>/i
    ];

    for (
      const pattern of titlePatterns
    ) {
      const titleMatch =
        card.match(pattern);

      if (
        titleMatch &&
        stripHtml(
          titleMatch[1]
        )
      ) {
        name =
          stripHtml(
            decodeHtml(
              titleMatch[1]
            )
          );

        break;
      }
    }

    result.push({
      slug,
      name,
      poster_url: poster
    });
  }

  return uniqueItems(result);
}

async function fetchGenreHtml(
  genreSlug,
  page
) {
  const url =
    `https://phim.nguonc.com/the-loai/${genreSlug}?load=1&sort_field=new&page=${page}`;

  try {
    const html =
      await fetchHtml(
        url,
        {
          headers: {
            "Referer":
              "https://phim.nguonc.com/",
            "Accept":
              "text/html,application/xhtml+xml"
          }
        }
      );

    const items =
      parseGenreHtml(html);

    console.log(
      `[genre-html] ${genreSlug} page ${page} -> ${items.length}`
    );

    if (items.length > 0) {
      return {
        items,
        source: "html",
        path: url
      };
    }
  } catch (err) {
    console.error(
      `[genre-html] ${genreSlug} -> ${err.message}`
    );
  }

  return null;
}

async function fetchGenreBlock(
  genreSlug,
  skip
) {
  const cacheKey =
    `genre:${genreSlug}:${skip}`;

  const cacheHit =
    cached(cacheKey);

  if (cacheHit) {
    return cacheHit;
  }

  /*
   * Stremio skip 0/100/200...
   *
   * NguồnC ~10 item/page.
   *
   * => 10 page.
   */

  const startPage =
    Math.floor(
      skip /
        NGUONC_ITEMS_PER_PAGE
    ) + 1;

  const promises = [];

  for (
    let i = 0;
    i < NGUONC_PAGES_PER_BATCH;
    i++
  ) {
    const page =
      startPage + i;

    promises.push(
      (async () => {
        /*
         * Ưu tiên JSON.
         */

        const json =
          await fetchGenreJson(
            genreSlug,
            page
          );

        if (json) {
          return json.items;
        }

        /*
         * Không có JSON -> HTML.
         */

        const html =
          await fetchGenreHtml(
            genreSlug,
            page
          );

        if (html) {
          return html.items;
        }

        return [];
      })()
    );
  }

  const pages =
    await Promise.all(
      promises
    );

  let items = [];

  for (const list of pages) {
    if (
      Array.isArray(list)
    ) {
      items =
        items.concat(list);
    }
  }

  const result =
    uniqueItems(items);

  return putCache(
    cacheKey,
    result,
    CACHE_SECONDS
  );
}

/*
 * ============================================================
 * MANIFEST
 * ============================================================
 */

const builder =
  new addonBuilder({
    id:
      "com.nguonc.stremio.addon.v45",

    version:
      "4.5.0",

    name:
      "NguonC API",

    description:
      "NguonC - Phim Lẻ, Phim Bộ và Thể Loại",

    resources: [
      "catalog",
      "meta",
      "stream"
    ],

    types: [
      "movie",
      "series"
    ],

    catalogs: [
      /*
       * PHIM LẺ
       */

      {
        type: "movie",

        id:
          "nguonc_movies",

        name:
          "NguonC - Phim Lẻ",

        pageSize:
          100,

        extraSupported: [
          "skip"
        ]
      },

      /*
       * PHIM BỘ
       */

      {
        type: "series",

        id:
          "nguonc_series",

        name:
          "NguonC - Phim Bộ",

        pageSize:
          100,

        extraSupported: [
          "skip"
        ]
      },

      /*
       * THỂ LOẠI PHIM LẺ
       */

      {
        type: "movie",

        id:
          "nguonc_genres",

        name:
          "NguonC - Thể Loại",

        pageSize:
          100,

        extraSupported: [
          "genre",
          "skip"
        ],

        extra: [
          {
            name:
              "genre",

            isRequired:
              false,

            options:
              GENRES.map(
                x => x.value
              ),

            optionsLimit:
              1
          },

          {
            name:
              "skip",

            isRequired:
              false
          }
        ]
      },

      /*
       * THỂ LOẠI PHIM BỘ
       */

      {
        type: "series",

        id:
          "nguonc_genres_series",

        name:
          "NguonC - Thể Loại Phim Bộ",

        pageSize:
          100,

        extraSupported: [
          "genre",
          "skip"
        ],

        extra: [
          {
            name:
              "genre",

            isRequired:
              false,

            options:
              GENRES.map(
                x => x.value
              ),

            optionsLimit:
              1
          },

          {
            name:
              "skip",

            isRequired:
              false
          }
        ]
      }
    ]
  });

/*
 * ============================================================
 * CATALOG HANDLER
 * ============================================================
 */

builder.defineCatalogHandler(
  async args => {
    try {
      const type =
        args.type;

      const id =
        args.id;

      const extra =
        args.extra || {};

      const skip =
        normalizeSkip(
          extra.skip
        );

      /*
       * ========================================
       * PHIM LẺ / PHIM BỘ
       * ========================================
       */

      if (
        id === "nguonc_movies" ||
        id === "nguonc_series"
      ) {
        const sourceType =
          id === "nguonc_series"
            ? "series"
            : "movie";

        const rawItems =
          await fetchCatalogBlock(
            sourceType,
            skip
          );

        const metas =
          rawItems.map(
            item =>
              itemToMeta(
                item,
                sourceType
              )
          );

        console.log(
          `[catalog] ${id} skip=${skip} -> ${metas.length}`
        );

        return {
          metas,

          cacheMaxAge:
            600
        };
      }

      /*
       * ========================================
       * THỂ LOẠI
       * ========================================
       */

      if (
        id === "nguonc_genres" ||
        id === "nguonc_genres_series"
      ) {
        const genreName =
          typeof extra.genre ===
          "string"
            ? extra.genre.trim()
            : "";

        if (!genreName) {
          return {
            metas: []
          };
        }

        const genreInfo =
          getGenreInfo(
            genreName
          );

        if (!genreInfo) {
          console.error(
            `[genre] Không tìm thấy genre: ${genreName}`
          );

          return {
            metas: []
          };
        }

        const sourceType =
          id ===
          "nguonc_genres_series"
            ? "series"
            : "movie";

        const rawItems =
          await fetchGenreBlock(
            genreInfo.slug,
            skip
          );

        const metas =
          rawItems.map(
            item =>
              itemToMeta(
                item,
                sourceType
              )
          );

        console.log(
          `[genre] ${genreName} (${genreInfo.slug}) skip=${skip} -> ${metas.length}`
        );

        return {
          metas,

          cacheMaxAge:
            600
        };
      }

      return {
        metas: []
      };

    } catch (err) {
      console.error(
        "[catalog] Error:",
        err.message
      );

      return {
        metas: []
      };
    }
  }
);

/*
 * ============================================================
 * META
 * ============================================================
 */

builder.defineMetaHandler(
  async ({
    type,
    id
  }) => {
    try {
      const {
        slug
      } =
        parseSlugAndIndex(
          id
        );

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
          `/film/${encodeURIComponent(
            slug
          )}`
        );

      const movie =
        extractMovie(
          data
        );

      if (!movie) {
        return {
          meta: {}
        };
      }

      const episodes =
        movie.episodes || [];

      const videos = [];

      episodes.forEach(
        (
          server,
          sIdx
        ) => {
          const serverName =
            server.server_name ||
            server.name ||
            `NguồnC ${sIdx + 1}`;

          const items =
            server.items ||
            server.server_data ||
            [];

          items.forEach(
            (
              ep,
              epIdx
            ) => {
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
          id:
            `nguonc:${slug}`,

          type,

          name:
            movie.name ||
            movie.title ||
            "Phim NguồnC",

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

    } catch (err) {
      console.error(
        "[meta] Error:",
        err.message
      );

      return {
        meta: {}
      };
    }
  }
);

/*
 * ============================================================
 * ID PARSER
 * ============================================================
 */

function parseSlugAndIndex(
  rawId
) {
  const clean =
    String(
      rawId || ""
    ).replace(
      /^nguonc:/,
      ""
    );

  const parts =
    clean.split(":");

  return {
    slug:
      parts[0] || "",

    sIdx:
      Number.isFinite(
        parseInt(
          parts[1],
          10
        )
      )
        ? parseInt(
            parts[1],
            10
          )
        : 0,

    epIdx:
      Number.isFinite(
        parseInt(
          parts[2],
          10
        )
      )
        ? parseInt(
            parts[2],
            10
          )
        : 0
  };
}

/*
 * ============================================================
 * STREAM
 * ============================================================
 */

builder.defineStreamHandler(
  async args => {
    try {
      const {
        slug,
        sIdx,
        epIdx
      } =
        parseSlugAndIndex(
          args.id
        );

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
              `/film/${encodeURIComponent(
                slug
              )}`
            )
          );
      }

      const movie =
        extractMovie(
          payload
        );

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
       * DIRECT M3U8
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
       * EMBED
       */

      if (embed) {
        try {
          const html =
            await fetchHtml(
              embed,
              {
                headers: {
                  "Referer":
                    "https://phim.nguonc.com/"
                }
              }
            );

          if (html) {
            const m3u8Match =
              html.match(
                /(https?:\/\/[^"'\\\s]+\.m3u8[^"'\\\s]*)/i
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
            "[stream] Parse embed error:",
            err.message
          );
        }

        /*
         * Web Player fallback
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

        cacheMaxAge:
          60
      };

    } catch (err) {
      console.error(
        "[stream] Error:",
        err.message
      );

      return {
        streams: []
      };
    }
  }
);

/*
 * ============================================================
 * START SERVER
 * ============================================================
 */

serveHTTP(
  builder.getInterface(),
  {
    port: PORT
  }
);

console.log(
  `NguonC Stremio Addon started on port ${PORT}`
);
