// TF-IDF helpers for search_tabs

/**
 * Tokenize text into words, lowercase, filter stopwords
 */
export function tokenize(text) {
  if (!text) return [];
  const stopwords = new Set(["the","is","at","which","on","a","an","and","or","but","in","with","to","for","of","not","no","can","had","has","this","that","are","was","were","be","been","being","have","from","by","as","it","its"]);
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopwords.has(w));
}

/**
 * Compute term frequency for a token list
 */
export function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  // Normalize by max frequency
  const maxFreq = Math.max(...tf.values(), 1);
  for (const [k, v] of tf) tf.set(k, v / maxFreq);
  return tf;
}

/**
 * Compute inverse document frequency across a corpus of token arrays
 */
export function idf(corpus) {
  const docCount = corpus.length;
  const df = new Map();
  for (const tokens of corpus) {
    const unique = new Set(tokens);
    for (const t of unique) df.set(t, (df.get(t) || 0) + 1);
  }
  const idfMap = new Map();
  for (const [t, d] of df) idfMap.set(t, Math.log(docCount / (1 + d)));
  return idfMap;
}

/**
 * Cosine similarity between two TF-IDF vectors (sparse maps)
 */
export function cosineSimilarity(vecA, vecB) {
  let dot = 0, magA = 0, magB = 0;
  for (const [k, v] of vecA) { magA += v * v; if (vecB.has(k)) dot += v * vecB.get(k); }
  for (const [, v] of vecB) magB += v * v;
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
