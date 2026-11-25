// Turns the prompt lists exported from the old websites into Prompt Lab items:
// a title, one category, tags, and a place in the order. No network here, so it
// can be tested on its own.

/** The set every imported item belongs to, shown with its switch in the Library. */
export const BATCH = "Website prompts";

/**
 * Imported items are dated just before this, so what is already in the app and
 * whatever is uploaded later stay above them.
 */
export const ORDER_BASE = Date.parse("2026-10-01T00:00:00Z");

/**
 * Photo tags in order of preference: the first one a row has becomes its
 * category. The app already shows a "Trending" chip of its own (the most viewed
 * items), so the old "Trending" label becomes "Viral".
 */
const PHOTO_CATEGORIES = [
  ["video", "Image to Video"],
  ["videos", "Image to Video"],
  ["couple", "Couple"],
  ["love", "Love"],
  ["birthday", "Birthday"],
  ["kids", "Kids"],
  ["boys", "Boys"],
  ["girls", "Girls"],
  ["portrait", "Portrait"],
  ["cinematic", "Cinematic"],
  ["funny", "Funny"],
  ["dp maker", "DP Maker"],
  ["sticker maker", "Sticker Maker"],
  ["product", "Product Ads"],
  ["daily", "Daily"],
  ["others", "Others"],
  ["trending", "Viral"],
  ["featured", "Featured"],
  ["new", "New"],
  ["ind", "India"],
  ["pak", "Pakistan"],
];
const CATEGORY_OF_TAG = new Map(PHOTO_CATEGORIES);

/** How a tag reads once tidied, when it stays a tag. */
const TAG_NAMES = new Map([
  ["ind", "India"],
  ["pak", "Pakistan"],
  ["others", "Others"],
  ["dp maker", "DP Maker"],
]);

/** Video categories that clash with a chip the app makes itself. */
const VIDEO_CATEGORY_NAMES = new Map([["trending", "Viral"]]);

function splitTags(text) {
  return String(text ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function photoCategory(tagText) {
  const tags = new Set(splitTags(tagText).map((tag) => tag.toLowerCase()));
  for (const [tag, category] of PHOTO_CATEGORIES) {
    if (tags.has(tag)) return category;
  }
  return "Others";
}

/** The other tags of a photo, tidied, without the category and "Video". */
export function photoTags(tagText, category) {
  const out = [];
  for (const raw of splitTags(tagText)) {
    const key = raw.toLowerCase();
    if (key === "video" || key === "videos") continue;
    const name =
      TAG_NAMES.get(key) ?? raw.charAt(0).toUpperCase() + raw.slice(1);
    if (name.toLowerCase() === category.toLowerCase()) continue;
    if (CATEGORY_OF_TAG.get(key) === category) continue;
    if (!out.some((t) => t.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out.slice(0, 10);
}

export function videoCategory(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return "Others";
  return VIDEO_CATEGORY_NAMES.get(trimmed.toLowerCase()) ?? trimmed.slice(0, 40);
}

// ------------------------------------------------------------------ titles

/** Sentences that are instructions about the upload, not a description. */
const INSTRUCTION =
  /\b(upload(ed)?|reference|attached|aspect ratio|ratio\b|identity|keep (my|the|his|her|their|this)|do not|don't|never|must|strictly|exactly|image ?[12]\b|@image|@video|if no|preserve|my face|my photo|same face|face (lock|swap|shape)|exact|identical|identit\w*|same (man|woman|person|boy|girl)|use (the|my|this|face))\b/i;

/** Words in front of the subject that say nothing about it. */
const LEADING = [
  /^(master\s+)?prompt\s*[?:\-–—]*\s*/i,
  /^(please\s+)?(create|generate|make|design|produce|render|draw|imagine|craft|show|transform|turn|convert|edit|change)\s+(me\s+)?(this|the|my|an?|one)?\s*/i,
  /^(into|to)\s+(an?|the)?\s*/i,
  /^(and|or|but|then|also)\s+/i,
  // The "16" left of "9:16".
  /^\d+\s+(?=\p{L})/u,
  /^(an?|the)\s+/i,
  /^(ultra|hyper|super|highly|photo|very)[\s-]*(realistic|detailed|photorealistic|real|high)\b[\s,]*/i,
  /^(realistic|photorealistic|photo-realistic|cinematic|dramatic|stunning|beautiful|professional|high[\s-]*(quality|resolution|end|contrast)|detailed|vertical|square|8k|4k|hd|uhd|3d|vibrant|moody|epic|gorgeous|premium|modern|minimal(ist)?|soft|bright|dark)\b[\s,]*/i,
];

/** The subject ends where the details begin. */
const CUT =
  /\s*(?:[,;:(\[{|]| - | – | — |\. | with | wearing | featuring | in the style| that | which | where | while | showing | holding | using )/i;

const SMALL_WORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "for", "to", "with", "and", "or",
  "from", "by", "as", "into",
]);
const TRAILING = new Set([...SMALL_WORDS, "his", "her", "their", "my", "your", "is", "are", "very"]);

function titleCase(words) {
  return words
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      // Keeps 8K, DP, 3D and names written in capitals.
      if (/[A-Z0-9]/.test(word.slice(1))) return word.charAt(0).toUpperCase() + word.slice(1);
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function strip(text) {
  let current = text.trim();
  for (let i = 0; i < 12; i++) {
    const before = current;
    for (const pattern of LEADING) current = current.replace(pattern, "");
    current = current.replace(/^[\s,.\-–—:"'*#]+/, "");
    if (current === before) break;
  }
  return current;
}

function shorten(phrase) {
  const words = phrase
    .replace(/["“”*#_`]/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[,;]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/[.!?:]+$/, ""))
    // A lone "/" or "+" is not a word; "&" in "Black & White" is.
    .filter((word) => word && (word === "&" || /[\p{L}\d]/u.test(word)))
    .slice(0, 9);
  while (words.length && TRAILING.has(words[words.length - 1].toLowerCase())) words.pop();
  let title = titleCase(words);
  while (title.length > 60) {
    words.pop();
    title = titleCase(words);
  }
  return title;
}

/** A heading written in capitals at the very start, like "CASH FLEX TREND – ...". */
function capsHeading(prompt) {
  const first = prompt.split(/\n| – | — | - |:|\(/)[0].trim();
  const letters = first.replace(/[^A-Za-z]/g, "");
  if (letters.length < 6 || letters !== letters.toUpperCase()) return null;
  const words = first.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 8) return null;
  // "CREATE A 4:5 PORTRAIT ..." is an instruction, not a heading.
  if (/^(create|generate|make|use|design|please|task|object|motorcycle name)\b/i.test(first)) {
    return null;
  }
  return titleCase(words.map((w) => w.toLowerCase()));
}

const KIND =
  "(?:portrait|photo(?:graph)?|image|poster|scene|shot|illustration|collage|picture|selfie|painting|artwork|wallpaper|figurine|sticker|cartoon|caricature|close-up|headshot|photoshoot|video|animation|thumbnail|banner|card|render|edit)s?";
const SUBJECT =
  "(?:man|men|woman|women|boy|boys|girl|girls|couple|child|children|kid|kids|baby|babies|family|lady|ladies|guy|person|people|character|bride|groom|cricketer|player|soldier|king|queen|prince|princess|model|cat|dog|car|bike|motorcycle|friends|brothers|sisters|mother|father|son|daughter|student|businessman|warrior|hero|superhero|doctor|farmer|chef|dancer|singer|athlete|teenager|gentleman|god|goddess|angel|robot|astronaut|male|female)";
const WORD = "[\\p{L}\\d'’&-]+";
/** "a cinematic portrait of a handsome, well-groomed man" and the like. */
const SUBJECT_PHRASE = new RegExp(
  `((?:${WORD}\\s+){0,3}${KIND}\\s+of\\s+(?:an?\\s+|the\\s+|two\\s+|three\\s+)?(?:${WORD},?\\s+){0,4}?${SUBJECT})(?!\\p{L})`,
  "iu",
);

const NAMES_SUBJECT = new RegExp(`\\b(${KIND}|${SUBJECT})\\b`, "i");
const KIND_PHRASE = new RegExp(`((?:${WORD}\\s+){1,3}${KIND})(?!\\p{L})`, "giu");
const SUBJECT_ONLY = new RegExp(`((?:${WORD}\\s+){1,2}${SUBJECT})(?!\\p{L})`, "giu");

/** A title needs at least two real words, not "0.0–2.5 S". */
function readable(title) {
  return title.split(" ").filter((word) => /\p{L}{3}/u.test(word)).length >= 2;
}

/** Mostly capitals reads as shouting; such titles are put in title case. */
function calm(title) {
  const letters = title.replace(/[^A-Za-z]/g, "");
  if (letters.length < 6 || letters !== letters.toUpperCase()) return title;
  return titleCase(title.toLowerCase().split(" "));
}

/** A short title from a prompt, for rows that came without one. */
export function titleFromPrompt(prompt, fallback = "Prompt") {
  const title = findTitle(String(prompt ?? "").replace(/\r/g, "").trim());
  return title ? calm(title) : fallback;
}

function findTitle(text) {
  const heading = capsHeading(text);
  if (heading) return heading;
  const found = SUBJECT_PHRASE.exec(text.slice(0, 600));
  if (found) {
    const title = shorten(strip(found[1]));
    if (title.split(" ").length >= 3 && readable(title)) return title;
  }
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const [index, sentence] of sentences.slice(0, 6).entries()) {
    if (INSTRUCTION.test(sentence)) continue;
    const subject = strip(sentence).split(CUT)[0];
    const title = shorten(subject);
    if (title.length < 8 || !readable(title)) continue;
    // A later sentence is often a detail ("Camera angle"); it must name a subject.
    if (index === 0 || NAMES_SUBJECT.test(title)) return title;
  }
  // Last tries: a short "celebration poster" or "stunning young woman" anywhere.
  const head = text.slice(0, 500);
  for (const pattern of [KIND_PHRASE, SUBJECT_ONLY]) {
    for (const match of head.matchAll(pattern)) {
      // "the uploaded reference image" is about the input, not the result.
      if (/\b(upload\w*|reference|input|original|given|provided|attached|same|my|this|your|first|second|each|every|of)\b/i.test(match[1])) {
        continue;
      }
      const title = shorten(strip(match[1]));
      if (title.split(" ").length >= 2 && readable(title)) return title;
    }
  }
  return null;
}

// ------------------------------------------------------------------- items

/** A video prompt that is only a command, like "/UGC ad", is not usable. */
function isCommandOnly(prompt) {
  const text = prompt.trim();
  return text.startsWith("/") && text.length < 40 && !/\s{2,}|\n/.test(text);
}

/**
 * Every row as an item to import, plus the rows left out and why. Items carry
 * the old links; the copy step replaces them with files in R2.
 */
export function planItems(photoRows, videoRows) {
  const items = [];
  const skipped = [];
  const seen = new Set();

  for (const row of photoRows) {
    const prompt = String(row.prompt ?? "").trim();
    const key = `photo-${row.id}`;
    if (!prompt) {
      skipped.push({ key, reason: "No prompt." });
      continue;
    }
    const dupe = `${prompt}|${row.imageUrl}`;
    if (seen.has(dupe)) {
      skipped.push({ key, reason: "Same prompt and image as another row." });
      continue;
    }
    seen.add(dupe);
    const category = photoCategory(row.tags);
    items.push({
      key,
      siteId: Number(row.id),
      contentType: "image",
      title: titleFromPrompt(prompt, `${category} Prompt`),
      prompt,
      category,
      tags: photoTags(row.tags, category),
      mediaUrl: String(row.imageUrl ?? "").trim(),
      thumbUrl: null,
    });
  }

  for (const row of videoRows) {
    const prompt = String(row.video_prompt ?? "").trim();
    const key = `video-${row.id}`;
    if (!prompt || isCommandOnly(prompt)) {
      skipped.push({ key, reason: `The prompt is only "${prompt}".` });
      continue;
    }
    const dupe = `${prompt}|${row.video}`;
    if (seen.has(dupe)) {
      skipped.push({ key, reason: "Same prompt and video as another row." });
      continue;
    }
    seen.add(dupe);
    const category = videoCategory(row.category);
    const given = String(row.title ?? "").replace(/\s+/g, " ").trim();
    items.push({
      key,
      siteId: Number(row.id),
      contentType: "video",
      title: (given || titleFromPrompt(prompt, `${category} Video`)).slice(0, 120),
      prompt,
      category,
      tags: [],
      mediaUrl: String(row.video ?? "").trim(),
      thumbUrl: String(row.image ?? "").trim() || null,
    });
  }

  return { items: orderItems(items), skipped };
}

/**
 * Gives every item a date so the app, which lists the newest first, shows a mix:
 * one item from each category in turn, newest first within a category. The app
 * loads only the newest few hundred, so this way every category has some.
 */
export function orderItems(items) {
  const groups = new Map();
  for (const item of items) {
    const group = `${item.contentType}|${item.category}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  const queues = [...groups.values()]
    .map((list) => list.sort((a, b) => b.siteId - a.siteId))
    .sort((a, b) => b.length - a.length);
  const ordered = [];
  for (let round = 0; ordered.length < items.length; round++) {
    for (const queue of queues) if (round < queue.length) ordered.push(queue[round]);
  }
  return ordered.map((item, rank) => ({
    ...item,
    createdAt: new Date(ORDER_BASE - rank * 1000).toISOString(),
  }));
}
