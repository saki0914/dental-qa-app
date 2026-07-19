const UNCATEGORIZED_SUBJECT = "未分類";

function normalizeValues(values) {
  const source = Array.isArray(values) ? values : [values];
  return [...new Set(source.map(value => String(value || "").trim()).filter(Boolean))];
}

export function normalizeImageMaterial(material = {}) {
  const subject = String(material.subject || "").trim() || UNCATEGORIZED_SUBJECT;
  const categories = normalizeValues(
    Array.isArray(material.categories) ? material.categories : material.tags
  );

  return {
    ...material,
    subject,
    categories,
    // Keep the legacy field while older clients may still read it.
    tags: categories
  };
}

export function getImageMemorySubjects(materials) {
  return [...new Set(
    (Array.isArray(materials) ? materials : [])
      .map(material => normalizeImageMaterial(material).subject)
  )].sort();
}

export function getImageMemoryCategories(materials, subject = "all") {
  return [...new Set(
    (Array.isArray(materials) ? materials : [])
      .map(normalizeImageMaterial)
      .filter(material => subject === "all" || material.subject === subject)
      .flatMap(material => material.categories)
  )].sort();
}

export function normalizeImageMemoryFilter(materials, filter = {}) {
  const subjects = getImageMemorySubjects(materials);
  const requestedSubject = String(filter.subject || "all").trim();
  const subject = requestedSubject !== "all" && subjects.includes(requestedSubject)
    ? requestedSubject
    : "all";
  const categories = getImageMemoryCategories(materials, subject);
  const requestedCategory = String(filter.category || "").trim();
  const category = categories.includes(requestedCategory) ? requestedCategory : "";

  return { subject, category };
}

export function filterImageMemoryMaterials(materials, filter = {}) {
  const normalizedFilter = normalizeImageMemoryFilter(materials, filter);
  const query = String(filter.query || "").trim().toLowerCase();

  return (Array.isArray(materials) ? materials : [])
    .map(normalizeImageMaterial)
    .filter(material => {
      const searchText = [
        material.title,
        material.subject,
        material.sourceName,
        material.pdfName,
        material.categories.join(" ")
      ].join(" ").toLowerCase();

      return (!query || searchText.includes(query)) &&
        (normalizedFilter.subject === "all" || material.subject === normalizedFilter.subject) &&
        (!normalizedFilter.category || material.categories.includes(normalizedFilter.category));
    });
}

