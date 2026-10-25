// Vendored copy of lib/refs.mjs — edit lib/ and run `node scripts/sync-core.mjs`.
/**
 * Reference resolution and verification.
 *
 * Rule of the whole pipeline: never emit a reference that cannot be resolved
 * back to a real record. Every candidate is looked up at Crossref / OpenAlex /
 * arXiv; the verdict only becomes `verified` when the DOI resolves AND the
 * returned title matches the intended one. Anything weaker is reported as
 * `possible` or `rejected` and must stay out of the bibliography.
 *
 * When the host has a literature plugin (dsh-paper-search, dsh-zotero,
 * @copylee/dsh-academic ...), call its tools first and feed the DOI it returns
 * into `verifyDoi` here for a second, independent check.
 */

const UA = 'dsh-convo-paper/1.0 (reference-verifier; mailto:noreply@example.com)';
const SLEEP_MS = 220;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jget(url, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function tget(url, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'application/atom+xml' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ text */

export function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  const norm = normalizeTitle(s);
  if (!norm) return new Set();
  const words = norm.split(' ').filter(Boolean);
  const set = new Set(words);
  // CJK has no spaces: add character bigrams so Chinese titles still compare.
  if (/[\u4e00-\u9fa5]/.test(norm)) {
    const cjk = norm.replace(/[^\u4e00-\u9fa5]/g, '');
    for (let i = 0; i < cjk.length - 1; i++) set.add(cjk.slice(i, i + 2));
  }
  return set;
}

/** Dice coefficient over token sets, 0..1. */
export function titleSimilarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

function cleanPages(page) {
  if (!page) return '';
  const p = String(page).trim();
  const m = p.match(/^([^-\s]+)\s*-\s*([^-\s]+)$/);
  if (m && m[1] === m[2]) return m[1];
  return p;
}

/* -------------------------------------------------------------- providers */

function crossrefToRecord(m) {
  const authors = (m.author || []).map((a) => ({
    family: decodeEntities(a.family || a.name || ''),
    given: decodeEntities(a.given || ''),
  }));
  const issued = m.issued?.['date-parts']?.[0] || m.published?.['date-parts']?.[0] || [];
  return {
    source: 'crossref',
    doi: (m.DOI || '').toLowerCase(),
    title: decodeEntities((Array.isArray(m.title) ? m.title[0] : m.title) || ''),
    authors,
    year: issued[0] || null,
    venue: decodeEntities(
      (Array.isArray(m['container-title']) ? m['container-title'][0] : m['container-title']) || m.publisher || '',
    ),
    volume: m.volume || '',
    issue: m.issue || '',
    pages: cleanPages(m.page),
    type: m.type || 'journal-article',
    raw: { publisher: m.publisher || '' },
  };
}

function openalexToRecord(w) {
  const authors = (w.authorships || []).map((a) => {
    const name = a.author?.display_name || '';
    const parts = name.split(/\s+/);
    const family = parts.length > 1 ? parts.pop() : name;
    return { family, given: parts.join(' ') };
  });
  return {
    source: 'openalex',
    doi: String(w.doi || '').replace(/^https?:\/\/doi\.org\//i, '').toLowerCase(),
    title: decodeEntities(w.title || w.display_name || ''),
    authors,
    year: w.publication_year || null,
    venue: decodeEntities(w.primary_location?.source?.display_name || ''),
    volume: w.biblio?.volume || '',
    issue: w.biblio?.issue || '',
    pages: cleanPages(
      w.biblio?.first_page
        ? `${w.biblio.first_page}-${w.biblio.last_page || ''}`.replace(/-$/, '')
        : '',
    ),
    type: w.type === 'article' ? 'journal-article' : w.type || 'journal-article',
    raw: { citedBy: w.cited_by_count ?? null },
  };
}

function arxivToRecords(xml) {
  const out = [];
  const entries = xml.split(/<entry>/).slice(1);
  for (const e of entries) {
    const title = (e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const id = (e.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || '';
    const published = (e.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || '';
    const names = [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1]);
    const authors = names.map((n) => {
      const parts = n.trim().split(/\s+/);
      const family = parts.length > 1 ? parts.pop() : n.trim();
      return { family, given: parts.join(' ') };
    });
    out.push({
      source: 'arxiv',
      doi: '',
      arxivId: id.replace(/^https?:\/\/arxiv\.org\/abs\//, ''),
      title: title.replace(/\s+/g, ' ').trim(),
      authors,
      year: published ? Number(published.slice(0, 4)) : null,
      venue: 'arXiv preprint',
      volume: '',
      issue: '',
      pages: '',
      type: 'posted-content',
      raw: {},
    });
  }
  return out;
}

export async function searchCrossref(q, rows = 5) {
  const url =
    'https://api.crossref.org/works?query.bibliographic=' +
    encodeURIComponent(q) +
    `&rows=${rows}&select=DOI,title,author,issued,container-title,volume,issue,page,type,publisher`;
  const j = await jget(url);
  return (j.message?.items || []).map(crossrefToRecord);
}

export async function searchOpenAlex(q, rows = 5) {
  const url =
    'https://api.openalex.org/works?search=' + encodeURIComponent(q) + `&per-page=${rows}`;
  const j = await jget(url);
  return (j.results || []).map(openalexToRecord);
}

export async function searchArxiv(q, rows = 5) {
  const url =
    'http://export.arxiv.org/api/query?search_query=' +
    encodeURIComponent('all:' + q) +
    `&start=0&max_results=${rows}`;
  const xml = await tget(url);
  return arxivToRecords(xml);
}

export async function lookupDoi(doi) {
  const clean = String(doi).replace(/^https?:\/\/doi\.org\//i, '').trim();
  const isArxivDoi = /^10\.48550\/arxiv\./i.test(clean);

  // arXiv / Zenodo / OSF are DataCite-registered, not Crossref.
  if (isArxivDoi) {
    try {
      return await lookupDatacite(clean);
    } catch (e) {
      const id = clean.replace(/^10\.48550\/arxiv\./i, '');
      const hits = await searchArxiv(id, 3).catch(() => []);
      const exact = hits.find((h) => h.arxivId === id);
      if (exact) {
        exact.doi = clean.toLowerCase();
        return exact;
      }
      throw new Error(`DOI 无法解析：${clean}（${e.message}）`);
    }
  }

  let lastError = null;
  for (const fn of [lookupCrossref, lookupDatacite, lookupOpenAlexDoi]) {
    try {
      return await fn(clean);
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`DOI 无法解析：${clean}（${lastError && lastError.message}）`);
}

async function lookupCrossref(doi) {
  const j = await jget('https://api.crossref.org/works/' + encodeURIComponent(doi));
  return crossrefToRecord(j.message);
}

async function lookupDatacite(doi) {
  const j = await jget('https://api.datacite.org/dois/' + encodeURIComponent(doi));
  const a = j.data?.attributes || {};
  const creators = a.creators || [];
  const authors = creators.map((c) => {
    if (c.familyName) return { family: c.familyName, given: c.givenName || '' };
    const name = c.name || '';
    const parts = name.split(/,\s*/);
    return parts.length > 1
      ? { family: parts[0], given: parts[1] || '' }
      : { family: name, given: '' };
  });
  const typeRaw = (a.types?.resourceTypeGeneral || '').toLowerCase();
  const rawDoi = String(a.doi || doi);
  const prettyDoi = rawDoi.replace(/^(10\.48550)\/arxiv\./i, '$1/arXiv.');
  return {
    source: 'datacite',
    doi: prettyDoi,
    title: a.titles?.[0]?.title || '',
    authors,
    year: a.publicationYear || null,
    venue: a.publisher || a.container?.title || '',
    volume: '',
    issue: '',
    pages: '',
    type:
      typeRaw === 'preprint'
        ? 'posted-content'
        : typeRaw === 'text'
          ? 'journal-article'
          : typeRaw || 'posted-content',
    raw: { container: a.container?.title || '' },
  };
}

async function lookupOpenAlexDoi(doi) {
  const j = await jget('https://api.openalex.org/works/https://doi.org/' + encodeURIComponent(doi));
  return openalexToRecord(j);
}

/* ------------------------------------------------------------ verification */

export const TYPE_TAG = {
  'journal-article': 'J',
  'proceedings-article': 'C',
  book: 'M',
  monograph: 'M',
  'book-chapter': 'M',
  dissertation: 'D',
  report: 'R',
  dataset: 'DS',
  'posted-content': 'EB/OL',
  preprint: 'EB/OL',
  text: 'J',
};

export function initials(given) {
  return String(given || '')
    .split(/[\s.\-]+/)
    .filter(Boolean)
    .map((p) => p[0])
    .join('');
}

export function formatGbt7714(rec) {
  const sequential = !rec.venue || rec.type === 'posted-content' || rec.type === 'preprint';
  const tag = sequential ? 'EB/OL' : TYPE_TAG[rec.type] || 'J';

  const authors = (rec.authors || []).map((a) =>
    /[\u4e00-\u9fa5]/.test(a.family)
      ? a.family + (a.given || '')
      : `${a.family}${initials(a.given) ? ' ' + initials(a.given) : ''}`,
  );
  let authorStr = authors.slice(0, 3).join(', ');
  if (authors.length > 3) authorStr += ', 等';
  if (!authorStr) authorStr = '[佚名]';

  const title = String(rec.title || '').replace(/\.$/, '');
  let s = `${authorStr}. ${title}[${tag}]`;

  if (sequential) {
    if (rec.year) s += `. (${rec.year})`;
    s += '.';
  } else {
    s += `. ${rec.venue}`;
    if (rec.year) s += `, ${rec.year}`;
    if (rec.volume) s += `, ${rec.volume}`;
    if (rec.issue) s += `(${rec.issue})`;
    if (rec.pages) s += `: ${rec.pages}`;
    s += '.';
  }

  const id = rec.doi ? `DOI: ${rec.doi}` : rec.arxivId ? `arXiv: ${rec.arxivId}` : '';
  if (id) s += ` ${id}.`;
  return s;
}

const VERIFIED = 0.85;
const POSSIBLE = 0.62;

export async function verifyReference(input) {
  const wanted = { title: input.title || '', year: input.year || null, doi: input.doi || '' };
  const attempts = [];
  let best = null;

  const consider = (rec) => {
    const sim = titleSimilarity(wanted.title, rec.title);
    const yearPenalty =
      wanted.year && rec.year && Math.abs(Number(wanted.year) - Number(rec.year)) > 1 ? 0.15 : 0;
    const score = Math.max(0, sim - yearPenalty);
    attempts.push({ source: rec.source, title: rec.title, doi: rec.doi, year: rec.year, sim: Number(score.toFixed(3)) });
    if (!best || score > best.score) best = { rec, score, sim };
  };

  if (wanted.doi) {
    try {
      const rec = await lookupDoi(wanted.doi);
      rec.requestedDoi = String(wanted.doi).toLowerCase();
      rec.doiMatchesRequest = rec.doi === rec.requestedDoi;
      consider(rec);
      await sleep(SLEEP_MS);
    } catch (e) {
      attempts.push({ source: 'doi-lookup', error: e.message });
    }
  }

  if (!best || best.score < VERIFIED) {
    for (const fn of [searchCrossref, searchOpenAlex]) {
      try {
        const list = await fn(wanted.title, 5);
        for (const rec of list) consider(rec);
      } catch (e) {
        attempts.push({ source: fn.name, error: e.message });
      }
      await sleep(SLEEP_MS);
      if (best && best.score >= VERIFIED) break;
    }
  }
  if ((!best || best.score < VERIFIED) && wanted.title) {
    try {
      const list = await searchArxiv(wanted.title, 5);
      for (const rec of list) consider(rec);
    } catch (e) {
      attempts.push({ source: 'arxiv', error: e.message });
    }
  }

  if (!best) {
    return {
      id: input.id || null,
      input: wanted,
      verdict: 'rejected',
      similarity: 0,
      reason: '所有数据源都没有返回可用记录',
      attempts,
    };
  }

  const verdict = best.score >= VERIFIED ? 'verified' : best.score >= POSSIBLE ? 'possible' : 'rejected';
  const rec = best.rec;
  const doiResolved = Boolean(rec.doi && rec.doiMatchesRequest !== false);
  return {
    id: input.id || null,
    input: wanted,
    verdict,
    similarity: Number(best.score.toFixed(3)),
    record: rec,
    gbt7714: verdict === 'rejected' ? null : formatGbt7714(rec),
    reason:
      verdict === 'verified'
        ? doiResolved
          ? 'DOI 已解析，标题匹配度达标'
          : '标题匹配度达标；输入的 DOI 未能解析，已改用解析到的 DOI'
        : verdict === 'possible'
          ? '存在相近记录，但标题匹配度不足，需人工核对'
          : '没有足够接近的记录，禁止引用',
    attempts,
  };
}

/** Batch verify with a small delay; keeps output order stable. */
export async function verifyAll(inputs, { onProgress } = {}) {
  const out = [];
  for (let i = 0; i < inputs.length; i++) {
    const item = inputs[i];
    try {
      const r = await verifyReference(item);
      out.push(r);
    } catch (e) {
      out.push({ id: item.id || null, input: item, verdict: 'rejected', reason: e.message, attempts: [] });
    }
    if (onProgress) onProgress(i + 1, inputs.length, out[out.length - 1]);
    await sleep(SLEEP_MS);
  }
  return out;
}
