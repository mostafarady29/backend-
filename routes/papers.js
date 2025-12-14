/**
 * routes/papers.js
 * Papers router with integrated search logging to external Recommender API
 */

const express = require('express');
const { getPool, sql } = require('../config/database');
const { authenticateToken, authorizeAdmin } = require('../middleware/auth');
const jwt = require('jsonwebtoken');

// fetch support for Node < 18
const nodeFetch = (() => {
  try {
    return global.fetch ? global.fetch : null;
  } catch (e) {
    return null;
  }
})();
const fetchLib = nodeFetch || (() => {
  try {
    // eslint-disable-next-line global-require
    return require('node-fetch');
  } catch (e) {
    return null;
  }
})();

const router = express.Router();

const queryCache = new Map();
const CACHE_TTL = 60000; // ms

function getCacheKey(params) {
  return JSON.stringify(params);
}

function getCachedQuery(key) {
  const cached = queryCache.get(key);
  if (!cached) return null;
  // valid?
  if (Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  queryCache.delete(key);
  return null;
}

function setCachedQuery(key, data) {
  queryCache.set(key, { data, timestamp: Date.now() });
  // simple LRU-ish eviction when size grows
  if (queryCache.size > 200) {
    const firstKey = queryCache.keys().next().value;
    queryCache.delete(firstKey);
  }
}

/**
 * Search logging utilities
 * - non-blocking logging to recommender service
 * - simple retry
 * - dedupe within short time window per user+query
 */
const RECOMMENDER_URL = process.env.RECOMMENDER_URL || 'http://127.0.0.1:8000/api/interaction/search';
const LOG_DEDUPE_TTL = 30 * 1000; // 30s
const recentSearchLog = new Map(); // key => timestamp

function makeDedupeKey(userId, query) {
  return `${userId || 'anon'}::${query}`;
}

async function callFetch(url, body, options = {}) {
  const fetchImpl = fetchLib || global.fetch;
  if (!fetchImpl) {
    console.warn('[logSearchToRecommender] no fetch implementation available');
    return { ok: false, error: 'no_fetch' };
  }
  const { method = 'POST', timeout = 3000 } = options;

  // Use AbortController for timeout if available
  let controller;
  let signal;
  try {
    controller = new (global.AbortController || require('abort-controller'))();
    signal = controller.signal;
    setTimeout(() => controller.abort(), timeout);
  } catch (e) {
    controller = null;
    signal = undefined;
  }

  try {
    const fetchOptions = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal,
    };
    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    const res = await fetchImpl(url, fetchOptions);
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, status: res.status, body: text };
    }
    return { ok: true, status: res.status, body: text };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function logSearchToRecommender(userId, query, meta = {}) {
  // Dedupe: avoid spamming same user+query repeatedly
  try {
    const dedupeKey = makeDedupeKey(userId, query);
    const last = recentSearchLog.get(dedupeKey);
    if (last && (Date.now() - last) < LOG_DEDUPE_TTL) {
      // skip logging duplicate within TTL
      return { ok: true, skipped: true };
    }
    recentSearchLog.set(dedupeKey, Date.now());

    const payload = {
      user_id: userId || null,
      query: query,
      user_agent: meta.userAgent || null,
      client_ip: meta.ip || null,
      timestamp: new Date().toISOString()
    };

    // Fire and forget but with light retry logic (1 retry)
    const result = await callFetch(RECOMMENDER_URL, payload, { timeout: 3000 });
    if (result.ok) return { ok: true };
    // retry once quickly
    const retry = await callFetch(RECOMMENDER_URL, payload, { timeout: 3000 });
    if (retry.ok) return { ok: true, retried: true };
    console.warn('[logSearchToRecommender] failed to log search', result, retry);
    return { ok: false, error: result.error || result.body || 'unknown' };
  } catch (err) {
    console.error('[logSearchToRecommender] unexpected error:', err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  } finally {
    // cleanup old dedupe entries lazily
    setTimeout(() => {
      const cutoff = Date.now() - (LOG_DEDUPE_TTL * 4);
      for (const [k, ts] of recentSearchLog.entries()) {
        if (ts < cutoff) recentSearchLog.delete(k);
      }
    }, LOG_DEDUPE_TTL * 2).unref && setTimeout(() => { }, 0);
  }
}

/* ---------------------------
   ROUTES
   --------------------------- */

async function getRecommendations(userId, limit = 50) {
  try {
    const url = new URL(`${RECOMMENDER_URL.replace('/interaction/search', '/recommend')}`);
    if (userId) url.searchParams.append('user_id', userId);
    url.searchParams.append('top_n', limit);

    const result = await callFetch(url.toString(), null, { method: 'GET', timeout: 5000 });
    if (!result.ok) {
      console.warn('[getRecommendations] failed', result);
      return [];
    }

    try {
      const data = JSON.parse(result.body);
      if (data && data.recommendations) {
        return data.recommendations.map(r => r.paper_id);
      }
    } catch (parseErr) {
      console.warn('[getRecommendations] parse error', parseErr);
    }
    return [];
  } catch (err) {
    console.error('[getRecommendations] error', err);
    return [];
  }
}

router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 12;
    const fieldId = req.query.fieldId;
    const search = req.query.search;
    const offset = (page - 1) * limit;

    const cacheKey = getCacheKey({ page, limit, fieldId, search, userId: req.user ? req.user.userId : 'anon' });
    const cached = getCachedQuery(cacheKey);
    if (cached) return res.json(cached);

    // non-blocking log if search present
    if (search) {
      (async () => {
        try {
          let userId = null;
          const authHeader = req.headers['authorization'];
          if (authHeader) {
            const token = authHeader.split(' ')[1];
            if (token) {
              try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                if (decoded && decoded.userId) userId = decoded.userId;
              } catch (e) {
                // ignore invalid token for logging
              }
            }
          }
          await logSearchToRecommender(userId, search, { userAgent: req.headers['user-agent'], ip: req.ip });
        } catch (e) {
          console.warn('[search log fire-and-forget] error', e?.message || e);
        }
      })();
    }

    const pool = await getPool();

    // SPECIAL CASE: "For You" Feed
    // If no search and no field filter, try to get recommendations
    let recommendedPaperIds = [];
    let isRecommendation = false;

    if (!search && !fieldId) {
      try {
        let userId = null;
        const authHeader = req.headers['authorization'];
        if (authHeader) {
          const token = authHeader.split(' ')[1];
          try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            if (decoded && decoded.userId) userId = decoded.userId;
          } catch (e) { }
        }

        console.log('[DEBUG] getRecommendations userId:', userId, 'header:', !!authHeader);

        // Fetch more than needed to handle pagination simulation
        // The recommender API might cap at 50, so we just get the max useful amount
        const maxRecs = 50;
        const recIds = await getRecommendations(userId, maxRecs);

        if (recIds.length > 0) {
          recommendedPaperIds = recIds;
          isRecommendation = true;
        }
      } catch (err) {
        console.warn('Failed to fetch recommendations, falling back to chronological', err);
      }
    }

    // Initialize request
    const request = pool.request();
    let querySql = '';

    if (isRecommendation) {
      // Logic for retrieving recommended papers by ID
      // We need to slice the IDs based on pagination
      const pagedIds = recommendedPaperIds.slice(offset, offset + limit);

      if (pagedIds.length === 0) {
        // Page out of range of recommendations? Fallback to standard chronological?
        // For now, let's just return empty to indicate end of "For You" list
        // OR we could fallback. Let's fallback to standard query if page 1 logic fails,
        // but if page > 1 and no recs, it's just end of list.
        if (page === 1) {
          isRecommendation = false; // fallback
        } else {
          const response = {
            success: true,
            message: 'Papers retrieved successfully',
            data: {
              papers: [],
              pagination: { page, limit, total: recommendedPaperIds.length, pages: Math.ceil(recommendedPaperIds.length / limit) },
            },
          };
          setCachedQuery(cacheKey, response);
          return res.json(response);
        }
      } else {
        // Construct SQL for specific IDs
        // We need to preserve order. T-SQL doesn't verify `IN` order, so we join on a values table or use CASE.
        // Using OPENJSON or a temporary table might be overkill.
        // Let's just fetch them and sort in JS, or use a complex ORDER BY CASE.

        // Create parameters for these IDs
        pagedIds.forEach((id, index) => {
          request.input(`id_${index}`, sql.Int, id);
        });

        const idList = pagedIds.map((_, i) => `@id_${i}`).join(',');

        querySql = `
            SELECT 
                p.Paper_ID, 
                p.Title, 
                p.Abstract, 
                p.Publication_Date, 
                p.Path,
                f.Field_Name,
                f.Field_ID,
                ISNULL((SELECT COUNT(*) FROM Author_Paper WHERE Paper_ID = p.Paper_ID), 0) as Author_Count,
                ISNULL((SELECT COUNT(*) FROM [Download] WHERE Paper_ID = p.Paper_ID), 0) as Download_Count,
                ISNULL((SELECT AVG(CAST(Rating as FLOAT)) FROM Review WHERE Paper_ID = p.Paper_ID), 0) as Average_Rating
            FROM Paper p WITH (NOLOCK)
            LEFT JOIN Field f WITH (NOLOCK) ON p.Field_ID = f.Field_ID
            WHERE p.Paper_ID IN (${idList})
           `;
      }
    }

    if (!isRecommendation) {
      // STANDARD QUERY LOGIC (Fallback or Search/Filter)
      querySql = `
          SELECT 
            p.Paper_ID, 
            p.Title, 
            p.Abstract, 
            p.Publication_Date, 
            p.Path,
            f.Field_Name,
            f.Field_ID,
            ISNULL((SELECT COUNT(*) FROM Author_Paper WHERE Paper_ID = p.Paper_ID), 0) as Author_Count,
            ISNULL((SELECT COUNT(*) FROM [Download] WHERE Paper_ID = p.Paper_ID), 0) as Download_Count,
            ISNULL((SELECT AVG(CAST(Rating as FLOAT)) FROM Review WHERE Paper_ID = p.Paper_ID), 0) as Average_Rating
          FROM Paper p WITH (NOLOCK)
          LEFT JOIN Field f WITH (NOLOCK) ON p.Field_ID = f.Field_ID
          WHERE 1=1
        `;

      if (fieldId) {
        querySql += ' AND p.Field_ID = @fieldId';
        request.input('fieldId', sql.Int, fieldId);
      }

      if (search) {
        querySql += " AND (p.Title LIKE @search OR p.Abstract LIKE @search)";
        request.input('search', sql.NVarChar, `%${search}%`);
      }

      querySql += `
          ORDER BY p.Publication_Date DESC
          OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
        `;

      request.input('offset', sql.Int, offset);
      request.input('limit', sql.Int, limit);
    }

    const result = await request.query(querySql);
    let papers = result.recordset;

    // If recommendation, we need to manually sort the results to match the recommendation order
    if (isRecommendation) {
      // The slice we requested
      const pagedIds = recommendedPaperIds.slice(offset, offset + limit);

      // Map ID to paper object
      const paperMap = new Map(papers.map(p => [p.Paper_ID, p]));

      // Reconstruct array in order
      papers = pagedIds.map(id => paperMap.get(id)).filter(p => p);
    }

    // count total
    let total = 0;
    if (isRecommendation) {
      total = recommendedPaperIds.length;
    } else {
      let countQuery = `SELECT COUNT(*) as total FROM Paper p WITH (NOLOCK) WHERE 1=1`;
      const countRequest = pool.request();
      if (fieldId) {
        countQuery += ' AND p.Field_ID = @fieldId';
        countRequest.input('fieldId', sql.Int, fieldId);
      }
      if (search) {
        countQuery += " AND (p.Title LIKE @search OR p.Abstract LIKE @search)";
        countRequest.input('search', sql.NVarChar, `%${search}%`);
      }

      const countResult = await countRequest.query(countQuery);
      total = countResult.recordset[0].total;
    }

    const response = {
      success: true,
      message: isRecommendation ? 'Recommended papers retrieved' : 'Papers retrieved successfully',
      data: {
        papers: papers,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
        isRecommendation // optimization flag for UI
      },
    };

    setCachedQuery(cacheKey, response);
    res.json(response);
  } catch (error) {
    console.error('Get papers error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve papers',
      data: null,
    });
  }
});

router.get('/search/query', async (req, res) => {
  try {
    const query = req.query.q;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 12;
    const offset = (page - 1) * limit;

    if (!query) {
      return res.status(400).json({
        success: false,
        message: 'Search query is required',
        data: null,
      });
    }

    // extract user id if present in Authorization header
    let userId = null;
    const authHeader = req.headers['authorization'];
    if (authHeader) {
      const token = authHeader.split(' ')[1];
      if (token) {
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          if (decoded && decoded.userId) userId = decoded.userId;
        } catch (err) {
          // invalid token -> ignore logging but continue search
        }
      }
    }

    // non-blocking logging
    logSearchToRecommender(userId, query, { userAgent: req.headers['user-agent'], ip: req.ip })
      .then(info => {
        if (info && !info.ok) {
          console.warn('[search log] non-fatal:', info);
        }
      })
      .catch(err => console.warn('[search log] unexpected:', err?.message || err));

    const cacheKey = getCacheKey({ search: query, page, limit });
    const cached = getCachedQuery(cacheKey);

    if (cached) {
      return res.json(cached);
    }

    const pool = await getPool();
    const searchTerm = `%${query}%`;

    const result = await pool
      .request()
      .input('search', sql.NVarChar, searchTerm)
      .input('offset', sql.Int, offset)
      .input('limit', sql.Int, limit)
      .query(`
        WITH SearchResults AS (
          SELECT DISTINCT
            p.Paper_ID, 
            p.Title, 
            p.Abstract, 
            p.Publication_Date, 
            p.Path, 
            f.Field_ID,
            f.Field_Name,
            ISNULL((SELECT COUNT(*) FROM Author_Paper WHERE Paper_ID = p.Paper_ID), 0) as Author_Count,
            ISNULL((SELECT COUNT(*) FROM [Download] WHERE Paper_ID = p.Paper_ID), 0) as Download_Count,
            ISNULL((SELECT AVG(CAST(Rating as FLOAT)) FROM Review WHERE Paper_ID = p.Paper_ID), 0) as Average_Rating,
            1 as Relevance
          FROM Paper p WITH (NOLOCK)
          LEFT JOIN Field f WITH (NOLOCK) ON p.Field_ID = f.Field_ID
          WHERE 
            EXISTS (
              SELECT 1 FROM Paper_Keywords pk2 
              WHERE pk2.Paper_ID = p.Paper_ID 
              AND pk2.Keywords LIKE @search
            )
        )
        SELECT 
          Paper_ID,
          Title,
          Abstract,
          Publication_Date,
          Path,
          Field_ID,
          Field_Name,
          Author_Count,
          Download_Count,
          Average_Rating
        FROM SearchResults
        ORDER BY 
          Relevance ASC, 
          Average_Rating DESC, 
          Download_Count DESC,
          Publication_Date DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const countResult = await pool
      .request()
      .input('search', sql.NVarChar, searchTerm)
      .query(`
        SELECT COUNT(DISTINCT p.Paper_ID) as total 
        FROM Paper p WITH (NOLOCK)
        LEFT JOIN Field f WITH (NOLOCK) ON p.Field_ID = f.Field_ID
        WHERE 
          EXISTS (
            SELECT 1 FROM Paper_Keywords pk2 
            WHERE pk2.Paper_ID = p.Paper_ID 
            AND pk2.Keywords LIKE @search
          )
      `);

    const total = countResult.recordset[0].total;

    const response = {
      success: true,
      message: 'Search completed successfully',
      data: {
        papers: result.recordset,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
    };

    setCachedQuery(cacheKey, response);
    res.json(response);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      success: false,
      message: 'Search failed',
      data: null,
    });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const paperId = req.params.id;

    const cacheKey = getCacheKey({ paperId });
    const cached = getCachedQuery(cacheKey);

    if (cached) {
      return res.json(cached);
    }

    const pool = await getPool();

    const paperResult = await pool
      .request()
      .input('paperId', sql.Int, paperId)
      .query(`
        SELECT 
          p.Paper_ID, 
          p.Title, 
          p.Abstract, 
          p.Publication_Date, 
          p.Path, 
          p.Field_ID,
          f.Field_Name,
          ISNULL((SELECT COUNT(*) FROM [Download] WHERE Paper_ID = p.Paper_ID), 0) as Download_Count,
          ISNULL((SELECT AVG(CAST(Rating as FLOAT)) FROM Review WHERE PAPER_ID = p.Paper_ID), 0) as Average_Rating,
          ISNULL((SELECT COUNT(*) FROM Review WHERE Paper_ID = p.Paper_ID), 0) as Review_Count
        FROM Paper p WITH (NOLOCK)
        LEFT JOIN Field f WITH (NOLOCK) ON p.Field_ID = f.Field_ID
        WHERE p.Paper_ID = @paperId
      `);

    if (paperResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Paper not found',
        data: null,
      });
    }

    const paper = paperResult.recordset[0];

    const [authorsResult, keywordsResult, reviewsResult] = await Promise.all([
      pool
        .request()
        .input('paperId', sql.Int, paperId)
        .query(`
          SELECT a.Author_ID, a.First_Name, a.Last_Name, a.Email, a.Country
          FROM Author a WITH (NOLOCK)
          INNER JOIN Author_Paper ap WITH (NOLOCK) ON a.Author_ID = ap.Author_ID
          WHERE ap.Paper_ID = @paperId
        `),
      pool
        .request()
        .input('paperId', sql.Int, paperId)
        .query('SELECT Keywords FROM Paper_Keywords WITH (NOLOCK) WHERE Paper_ID = @paperId'),
      pool
        .request()
        .input('paperId', sql.Int, paperId)
        .query(`
          SELECT 
            r.Review_ID,
            r.Rating,
            r.Review_Date,
            r.Researcher_ID,
            u.Name as User_Name
          FROM Review r WITH (NOLOCK)
          INNER JOIN [User] u WITH (NOLOCK) ON r.Researcher_ID = u.User_ID
          WHERE r.Paper_ID = @paperId
          ORDER BY r.Review_Date DESC
        `)
    ]);

    const response = {
      success: true,
      message: 'Paper retrieved successfully',
      data: {
        ...paper,
        authors: authorsResult.recordset,
        keywords: keywordsResult.recordset.length > 0 ? keywordsResult.recordset[0].Keywords : '',
        reviews: reviewsResult.recordset,
      },
    };

    setCachedQuery(cacheKey, response);
    res.json(response);
  } catch (error) {
    console.error('Get paper error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve paper',
      data: null,
    });
  }
});

router.post('/:id/download', authenticateToken, async (req, res) => {
  try {
    const paperId = req.params.id;
    const researcherId = req.user.userId;

    const pool = await getPool();

    const paperCheck = await pool
      .request()
      .input('paperId', sql.Int, paperId)
      .query('SELECT Paper_ID, Path FROM Paper WHERE Paper_ID = @paperId');

    if (paperCheck.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Paper not found',
        data: null,
      });
    }

    await pool
      .request()
      .input('paperId', sql.Int, paperId)
      .input('researcherId', sql.Int, researcherId)
      .query(`
        INSERT INTO [Download] (Paper_ID, Researcher_ID, Download_Date)
        VALUES (@paperId, @researcherId, GETDATE())
      `);

    queryCache.delete(getCacheKey({ paperId }));

    res.json({
      success: true,
      message: 'Download recorded successfully',
      data: {
        path: paperCheck.recordset[0].Path,
      },
    });
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to record download',
      data: null,
    });
  }
});

router.post('/:id/review', authenticateToken, async (req, res) => {
  try {
    const paperId = req.params.id;
    const researcherId = req.user.userId;
    const { rating } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be between 1 and 5',
        data: null,
      });
    }

    const pool = await getPool();

    const paperCheck = await pool
      .request()
      .input('paperId', sql.Int, paperId)
      .query('SELECT Paper_ID FROM Paper WHERE Paper_ID = @paperId');

    if (paperCheck.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Paper not found',
        data: null,
      });
    }

    const existingReview = await pool
      .request()
      .input('paperId', sql.Int, paperId)
      .input('researcherId', sql.Int, researcherId)
      .query('SELECT Review_ID FROM Review WHERE Paper_ID = @paperId AND Researcher_ID = @researcherId');

    if (existingReview.recordset.length > 0) {
      await pool
        .request()
        .input('reviewId', sql.Int, existingReview.recordset[0].Review_ID)
        .input('rating', sql.Int, rating)
        .query('UPDATE Review SET Rating = @rating, Review_Date = GETDATE() WHERE Review_ID = @reviewId');

      queryCache.delete(getCacheKey({ paperId }));

      return res.json({
        success: true,
        message: 'Review updated successfully',
        data: null,
      });
    }

    await pool
      .request()
      .input('paperId', sql.Int, paperId)
      .input('researcherId', sql.Int, researcherId)
      .input('rating', sql.Int, rating)
      .query(`
        INSERT INTO Review (Paper_ID, Researcher_ID, Rating, Review_Date)
        VALUES (@paperId, @researcherId, @rating, GETDATE())
      `);

    queryCache.delete(getCacheKey({ paperId }));

    res.status(201).json({
      success: true,
      message: 'Review submitted successfully',
      data: null,
    });
  } catch (error) {
    console.error('Review error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit review',
      data: null,
    });
  }
});

router.get('/top-rated/by-field', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 3;

    const cacheKey = getCacheKey({ topRated: true, limit });
    const cached = getCachedQuery(cacheKey);

    if (cached) {
      return res.json(cached);
    }

    const pool = await getPool();

    const result = await pool
      .request()
      .input('limit', sql.Int, limit)
      .query(`
        WITH RankedPapers AS (
          SELECT 
            p.Paper_ID,
            p.Title,
            p.Abstract,
            p.Publication_Date,
            p.Path,
            f.Field_ID,
            f.Field_Name,
            ISNULL((SELECT AVG(CAST(Rating as FLOAT)) FROM Review WHERE Paper_ID = p.Paper_ID), 0) as Average_Rating,
            ISNULL((SELECT COUNT(*) FROM [Download] WHERE Paper_ID = p.Paper_ID), 0) as Download_Count,
            ISNULL((SELECT COUNT(*) FROM Review WHERE Paper_ID = p.Paper_ID), 0) as Review_Count,
            ROW_NUMBER() OVER (PARTITION BY f.Field_ID ORDER BY 
              ISNULL((SELECT AVG(CAST(Rating as FLOAT)) FROM Review WHERE Paper_ID = p.Paper_ID), 0) DESC,
              ISNULL((SELECT COUNT(*) FROM Review WHERE Paper_ID = p.Paper_ID), 0) DESC,
              p.Publication_Date DESC
            ) as RowNum
          FROM Paper p WITH (NOLOCK)
          INNER JOIN Field f WITH (NOLOCK) ON p.Field_ID = f.Field_ID
          WHERE EXISTS (SELECT 1 FROM Review WHERE Paper_ID = p.Paper_ID)
        )
        SELECT 
          Paper_ID,
          Title,
          Abstract,
          Publication_Date,
          Path,
          Field_ID,
          Field_Name,
          Average_Rating,
          Download_Count,
          Review_Count
        FROM RankedPapers
        WHERE RowNum <= @limit
        ORDER BY Field_Name, Average_Rating DESC
      `);

    const response = {
      success: true,
      message: 'Top-rated papers retrieved successfully',
      data: {
        papers: result.recordset,
      },
    };

    setCachedQuery(cacheKey, response);
    res.json(response);
  } catch (error) {
    console.error('Get top-rated papers error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve top-rated papers',
      data: null,
    });
  }
});

module.exports = router;
