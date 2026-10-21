const PERPLEXITY_AGENT_URL = 'https://api.perplexity.ai/v1/agent';
const PERPLEXITY_MODEL = 'openai/gpt-5.6-luna'; // change to your preferred model

const prompt=`You are a bibliographic research assistant. Given a transliterated book title, optional author, and optional approximate publication year, search Russian-language sources (publisher sites, bookstores like Ozon and Labirint, library catalogs, and review sites) to collect structured metadata about the book/edition.  

INPUT:
- Transliterated title: "Usy, peri͡a i khvosty : rasskazy russkikh pisateleĭ o zhivotnykh"
- Transliterated author (optional): ""
- Approximate publication year (optional): "2025"

TASK:
1. Reconstruct the most likely Cyrillic title and author name(s).
2. Search for the book across Russian sources.
3. Extract the metadata fields listed in the schema below.
4. Return ONLY a valid JSON object matching the schema exactly.

Output schema:

{  
  "$schema": "https://json-schema.org/draft/2020-12/schema",  
  "title": "OutputBookMetadata",  
  "type": "object",  
  "additionalProperties": false,  
  "required": [  
    "title_cyrillic",  
    "authors_cyrillic",  
    "illustrators_cyrillic",  
    "publisher_cyrillic",  
    "series_cyrillic",  
    "format",  
    "publication_year",  
    "isbn",  
    "age_rating",  
    "genre",  
    "listing_links",  
    "review_links"  
  ],  
  "properties": {  
    "title_cyrillic": {  
      "type": ["string", "null"],  
      "description": "Book title in Cyrillic; null if not determined."  
    },  
    "authors_cyrillic": {  
      "type": "array",  
      "items": { "type": "string" },  
      "description": "List of author names in Cyrillic; empty array if unknown."  
    },  
    "illustrators_cyrillic": {  
      "type": "array",  
      "items": { "type": "string" },  
      "description": "List of illustrator names in Cyrillic; empty array if none or unknown."  
    },  
    "publisher_cyrillic": {  
      "type": ["string", "null"],  
      "description": "Publisher name in Cyrillic; null if unknown."  
    },  
    "series_cyrillic": {  
      "type": ["string", "null"],  
      "description": "Series name in Cyrillic; null if not part of a series or unknown."  
    },  
    "format": {  
      "type": ["string", "null"],  
      "description": "Physical/digital format and number of pages, e.g., 'hardcover, 32 pages', 'paperback, 96 pages', 'audiobook'; null if unknown."  
    },  
    "publication_year": {  
      "type": ["integer", "null"],  
      "description": "Publication year of this edition; null if unknown."  
    },  
    "isbn": {  
      "type": "array",  
      "items": { "type": "string" },  
      "description": "List of ISBNs (prefer ISBN-13; include ISBN-10 if available); empty array if unknown."  
    },  
    "age_rating": {  
      "type": ["string", "null"],  
      "description": "Age rating as stated by publisher/retailer, in original language; null if not stated."  
    },  
    "genre": {  
      "type": ["string", "null"],  
      "description": "Genre or category, e.g., 'children's picture book / fairy tale'; null if unknown."  
    },  
    "listing_links": {  
      "type": "array",  
      "items": { "type": "string", "format": "uri" },  
      "maxItems": 10,  
      "description": "Up to 10 URLs of pages that list this edition, prioritized: publisher site, author site, Ozon, Labirint, then other reputable sources."  
    },  
    "review_links": {  
      "type": "array",  
      "items": { "type": "string", "format": "uri" },  
      "maxItems": 10,  
      "description": "Up to 10 URLs of pages with user reviews/ratings for this title/edition; may overlap with listing_links."  
    }  
  }  
}  

RULES:
- For any scalar field that is unknown, use null.
- For any array field with no data, use an empty array [].
- listing_links: prioritize publisher site, author site, Ozon, Labirint, then other reputable sources; max 10 links; deduplicate by domain.
- review_links: prioritize retailer review sections, then dedicated review sites (LiveLib, FantLab, etc.); overlap with listing_links is allowed; max 10 links.
- Do not invent data; only include what is supported by sources found.
- Output ONLY the JSON object, with no markdown, no code fences, no explanations, no extra text.


SEARCH STRATEGY — perform exactly 4 web_search invocations (3 queries each, 12 total):

Round 1 — Broad identification:
  1. "{transliterated_title} {transliterated_author}"
  2. "{transliterated_title} {transliterated_author} ISBN"
  3. "{transliterated_title} {transliterated_author} {approximate_year}"

Round 2 — Retailer listings:
  4. site:ozon.ru "{reconstructed_cyrillic_title}"
  5. site:labirint.ru "{reconstructed_cyrillic_title}"
  6. "{reconstructed_cyrillic_title}" {reconstructed_cyrillic_author} ISBN

Round 3 — Reviews and age rating:
  7. site:ozon.ru "{reconstructed_cyrillic_title}" отзывы
  8. site:labirint.ru "{reconstructed_cyrillic_title}" отзывы
  9. "{reconstructed_cyrillic_title}" {reconstructed_cyrillic_author} отзывы OR site:livelib.ru "{reconstructed_cyrillic_title}"

Round 4 — Publisher and cross-validation:
  10. site:ast.ru OR site:{publisher_domain} "{reconstructed_cyrillic_title}"
  11. "{reconstructed_cyrillic_title}" возраст OR "для детей"
  12. "{reconstructed_cyrillic_title}" {reconstructed_cyrillic_author} {approximate_year} издательство

FETCH_URL POLICY:
After all 4 rounds, you MUST attempt fetch_url on, in priority order:
1. Publisher's official book page (MANDATORY if such a URL appeared in any round).
2. Author's official book page, if present.
3. Library catalog / bibliographic database page, if present.

DO NOT fetch Ozon or Labirint product pages.  
If a fetch fails, fall back to the best corroborated snippet value.  

CROSS-VALIDATION:
ISBN, publication_year, and publisher_cyrillic must be corroborated by at least 2 independent sources (snippets and/or successful fetches) before finalizing; otherwise use null (or [] for lists).  

Only after completing all 4 search rounds AND any mandated fetch attempts may you produce the final JSON.  

Respond ONLY with valid JSON matching the schema.  `;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Perplexity')
    .addItem('Run selected queries', 'runSelectedQueries')
    .addToUi();
}

function runSelectedQueries() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('PERPLEXITY_API_KEY');
  if (!apiKey) {
    SpreadsheetApp.getUi().alert('Set PERPLEXITY_API_KEY in Script Properties first.');
    return;
  }

  try {
      const response = callPerplexity(prompt, apiKey);
      Browser.msgBox(response);
    } catch (err) {
      Browser.msgBox('Error: ' + err.message);
  }
}


function callPerplexity(prompt, apiKey) {
  const payload = {
    model: PERPLEXITY_MODEL,
    input: prompt,
    tools: [{ type: 'web_search' }, { "type": "fetch_url" , max_urls: 2}],
    instructions: "You are a bibliographic research assistant. You MUST perform exactly 4 separate web_search invocations (3 queries each) following the round structure provided in the user prompt. After all 4 rounds, you MUST attempt fetch_url on the publisher's official book page if such a URL appeared in any round's results. Do not skip any round. Do not rely on search snippets alone for ISBN, age_rating, or publisher confirmation. Cross-validate ISBN, publication_year, and publisher across at least 2 sources before finalizing. Respond ONLY with valid JSON matching the schema in the user prompt.",
    max_steps: 8
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + apiKey
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(PERPLEXITY_AGENT_URL, options);
  const code = response.getResponseCode();
  const text = response.getContentText();

  if (code !== 200) {
    throw new Error('HTTP ' + code + ' — ' + text.substring(0, 500));
  }

  const json = JSON.parse(text);

  if (json.error) {
    throw new Error(json.error.message || JSON.stringify(json.error));
  }

  var jsonString = JSON.stringify(json, null, 2);
  //return extractAgentText(json);
  return jsonString;
}

function extractAgentText(json) {
  const parts = [];

  for (const item of json.output || []) {
    if (item.type === 'message') {
      for (const content of item.content || []) {
        if (content.type === 'output_text' && content.text) {
          parts.push(content.text);
        }
      }
    }
  }

  return parts.join('\n\n') || 'No output text returned.';
}