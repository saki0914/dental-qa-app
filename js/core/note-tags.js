// Tags of notes (revision 16), after Obsidian's nested tags: a note has any
// number of tags, and "/" nests them ("口腔解剖学/4章" is under "口腔解剖学").
// A tag exists while a note has it, so there is no list of tags to keep in
// step with the notes. Choosing a tag shows the notes that have it or a tag
// under it. These functions hold no state.

export const NOTE_TAG_MAX_LENGTH = 60;
export const NOTE_TAG_MAX_COUNT = 20;
// Filters of the note list: every note, and the notes without tags (a value
// that no tag can have: tags are trimmed and have no control characters).
export const NOTE_TAG_FILTER_ALL = "";
export const NOTE_TAG_FILTER_NONE = "\u0000none";

const compareNames = new Intl.Collator("ja", { numeric: true, sensitivity: "base" }).compare;

// One tag as it is kept: NFKC (full-width letters, digits and "／" become
// half-width), no leading "#", every level trimmed, no empty level. "" when
// nothing is left or the tag is too long.
export function normalizeNoteTag(value) {
  const text = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/^[\s#]+/, "");
  const tag = text
    .split("/")
    .map(segment => segment.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("/");
  return tag.length > NOTE_TAG_MAX_LENGTH ? "" : tag;
}

// Tags that differ only in case are one tag (the first spelling is kept).
export function noteTagKey(tag) {
  return normalizeNoteTag(tag).toLowerCase();
}

export function normalizeNoteTags(values) {
  const seen = new Set();
  const tags = [];
  for (const value of Array.isArray(values) ? values : []) {
    const tag = normalizeNoteTag(value);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= NOTE_TAG_MAX_COUNT) break;
  }
  return tags;
}

export function noteTagsOf(note) {
  return normalizeNoteTags(note?.tags);
}

export function sameNoteTags(left, right) {
  const a = normalizeNoteTags(left);
  const b = normalizeNoteTags(right);
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

// "a/b/c" → ["a", "a/b", "a/b/c"].
export function noteTagAncestors(tag) {
  const segments = normalizeNoteTag(tag).split("/").filter(Boolean);
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

export function noteTagName(tag) {
  const segments = normalizeNoteTag(tag).split("/");
  return segments[segments.length - 1] || "";
}

// `tag` is `parent` or a tag under it.
export function isNoteTagWithin(tag, parent) {
  const child = noteTagKey(tag);
  const root = noteTagKey(parent);
  return Boolean(child && root) && (child === root || child.startsWith(`${root}/`));
}

export function noteHasTag(note, tag) {
  return noteTagsOf(note).some(item => isNoteTagWithin(item, tag));
}

export function matchesNoteTagFilter(note, filter) {
  if (!filter) return true;
  if (filter === NOTE_TAG_FILTER_NONE) return noteTagsOf(note).length === 0;
  return noteHasTag(note, filter);
}

function searchText(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

// Every word of `query` is in the note's title or one of its tags ("#" before
// a word is ignored, as in Obsidian's tag search).
export function noteMatchesQuery(note, query) {
  const words = searchText(query).split(" ").map(word => word.replace(/^#+/, "")).filter(Boolean);
  if (!words.length) return true;
  const haystack = searchText([note?.title || "", ...noteTagsOf(note)].join("\n"));
  return words.every(word => haystack.includes(word));
}

export function filterNotesByTag(notes, { tag = NOTE_TAG_FILTER_ALL, query = "" } = {}) {
  return (Array.isArray(notes) ? notes : []).filter(note => matchesNoteTagFilter(note, tag) && noteMatchesQuery(note, query));
}

// The tags of `notes` as a tree: { tag, name, depth, count, children }, each
// level sorted by name ("2章" before "10章"). `count` is the number of notes
// that have the tag or a tag under it. A level keeps the first spelling met.
export function buildNoteTagTree(notes) {
  const root = new Map();
  for (const note of Array.isArray(notes) ? notes : []) {
    const counted = new Set();
    for (const tag of noteTagsOf(note)) {
      let level = root;
      let parentTag = "";
      let depth = 0;
      for (const segment of tag.split("/")) {
        const key = segment.toLowerCase();
        if (!level.has(key)) {
          level.set(key, { tag: parentTag ? `${parentTag}/${segment}` : segment, name: segment, depth, count: 0, children: new Map() });
        }
        const node = level.get(key);
        const nodeKey = node.tag.toLowerCase();
        if (!counted.has(nodeKey)) {
          counted.add(nodeKey);
          node.count += 1;
        }
        level = node.children;
        parentTag = node.tag;
        depth += 1;
      }
    }
  }
  const toList = level => [...level.values()]
    .sort((left, right) => compareNames(left.name, right.name) || left.name.localeCompare(right.name))
    .map(node => ({ tag: node.tag, name: node.name, depth: node.depth, count: node.count, children: toList(node.children) }));
  return toList(root);
}

// The tree in display order, one row per tag.
export function flattenNoteTagTree(tree) {
  const rows = [];
  const visit = nodes => nodes.forEach(node => {
    rows.push({ tag: node.tag, name: node.name, depth: node.depth, count: node.count, hasChildren: node.children.length > 0 });
    visit(node.children);
  });
  visit(Array.isArray(tree) ? tree : []);
  return rows;
}

export function countUntaggedNotes(notes) {
  return (Array.isArray(notes) ? notes : []).filter(note => noteTagsOf(note).length === 0).length;
}

// `from` and every tag under it renamed: "from/x" becomes "to/x". Tags that
// become the same are kept once.
export function renameNoteTagInList(tags, from, to) {
  const source = normalizeNoteTag(from);
  const target = normalizeNoteTag(to);
  const list = normalizeNoteTags(tags);
  if (!source || !target) return list;
  const depth = source.split("/").length;
  return normalizeNoteTags(list.map(tag => {
    if (!isNoteTagWithin(tag, source)) return tag;
    const rest = tag.split("/").slice(depth);
    return [target, ...rest].join("/");
  }));
}

// `tag` and every tag under it taken off.
export function removeNoteTagFromList(tags, tag) {
  return normalizeNoteTags(tags).filter(item => !isNoteTagWithin(item, tag));
}

// The filter as words for the list's status line.
export function describeNoteTagFilter(filter) {
  if (!filter) return "すべてのノート";
  if (filter === NOTE_TAG_FILTER_NONE) return "タグなし";
  return `#${filter}`;
}
