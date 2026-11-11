const ASN_ORIGIN = "https://asn.desire2learn.com";
const ASN_SCHEMA = "http://purl.org/ASN/schema/core/";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const GEM = "http://purl.org/gem/qualifiers/";
const MAX_CONCURRENT_DOWNLOADS = 4;
const CURATED_VERSION_GROUPS = {
  "CAN-ON": [
    { latestId: "D21699313", supersededIds: ["D2754782", "D2699567"] },
    { latestId: "D21395205", supersededIds: ["D2692056"] },
    { latestId: "D21128810", supersededIds: ["D2684099"] },
    { latestId: "D21038355", supersededIds: ["D2691532"] },
    { latestId: "D2973927", supersededIds: ["D2700213"] },
    { latestId: "D2973928", supersededIds: ["D2690128"] },
    { latestId: "D21271377", supersededIds: ["D2686664"] },
  ],
};

function fieldValues(resource, field) {
  const predicate = Object.hasOwn(resource, field)
    ? field
    : Object.keys(resource).find((key) => key.endsWith(`/${field}`) || key.endsWith(`#${field}`));
  const values = predicate ? resource[predicate] : [];
  return Array.isArray(values)
    ? values.map((entry) => entry?.value).filter((value) => typeof value === "string")
    : [];
}

function firstFieldValue(resource, field) {
  return fieldValues(resource, field)[0] ?? null;
}

function resourceId(uri) {
  return uri.split(/[\/#]/).at(-1) ?? uri;
}

function resourceTerms(resource, field) {
  return fieldValues(resource, field).map(resourceId);
}

function hasType(resource, typeUri) {
  return fieldValues(resource, "type").includes(typeUri);
}

function parseCatalog(html, jurisdiction) {
  const match = html.match(/\bconst\s+STATES\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) {
    throw new Error(`The ASN catalog for ${jurisdiction} did not contain its document list.`);
  }

  let entries;
  try {
    entries = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`The ASN catalog for ${jurisdiction} contained invalid JSON.`, { cause: error });
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`The ASN catalog for ${jurisdiction} contained no curriculum documents.`);
  }

  const seenIds = new Set();
  return entries.map((entry, index) => {
    if (
      !entry ||
      typeof entry.title !== "string" ||
      typeof entry.link !== "string" ||
      !/^D\d+$/.test(entry.link) ||
      typeof entry.year !== "string" ||
      typeof entry.status !== "string"
    ) {
      throw new Error(`The ASN catalog for ${jurisdiction} has an invalid entry at index ${index}.`);
    }
    if (seenIds.has(entry.link)) {
      throw new Error(`The ASN catalog for ${jurisdiction} repeats document ID ${entry.link}.`);
    }
    seenIds.add(entry.link);
    return {
      id: entry.link,
      title: entry.title,
      year: entry.year,
      status: entry.status,
    };
  });
}

async function fetchText(fetchImpl, url, description) {
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new Error(`Could not fetch ${description} from ${url}.`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`Could not fetch ${description}: HTTP ${response.status} from ${url}.`);
  }
  return response.text();
}

function summarizeDocument(catalogEntry, resources) {
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) {
    throw new Error(`ASN document ${catalogEntry.id} did not contain a resource map.`);
  }

  const entries = Object.entries(resources);
  const documentEntry = entries.find(([uri, resource]) =>
    resourceId(uri) === catalogEntry.id &&
    hasType(resource, `${ASN_SCHEMA}StandardDocument`));
  if (!documentEntry) {
    throw new Error(`ASN document ${catalogEntry.id} did not contain its StandardDocument resource.`);
  }

  const documentResource = documentEntry[1];
  const statements = entries
    .filter(([, resource]) => hasType(resource, `${ASN_SCHEMA}Statement`))
    .map(([uri, resource]) => {
      const label = firstFieldValue(resource, "statementLabel");
      const text = firstFieldValue(resource, "description");
      const parentUris = fieldValues(resource, `${GEM}isChildOf`);
      const childUris = fieldValues(resource, `${GEM}hasChild`);
      return {
        id: resourceId(uri),
        label,
        code: firstFieldValue(resource, `${ASN_SCHEMA}statementNotation`),
        text,
        parentIds: parentUris.map(resourceId),
        childIds: childUris.map(resourceId),
        subjects: resourceTerms(resource, "subject"),
        educationLevels: resourceTerms(resource, "educationLevel"),
        languageUris: fieldValues(resource, "language").map(resourceId),
      };
    });

  return {
    id: catalogEntry.id,
    year: catalogEntry.year,
    subjects: resourceTerms(documentResource, "subject"),
    educationLevels: resourceTerms(documentResource, "educationLevel"),
    valid: fieldValues(documentResource, "valid"),
    statements,
  };
}

function validYear(document) {
  const years = document.valid
    .map((value) => /^\d{4}$/.test(value) ? Number(value) : null)
    .filter((year) => year !== null);
  return years.length ? Math.max(...years) : null;
}

function applyCuratedVersions(jurisdiction, documents) {
  const groups = CURATED_VERSION_GROUPS[jurisdiction] ?? [];
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const excludedById = new Map();

  for (const group of groups) {
    const latest = documentsById.get(group.latestId);
    if (!latest) continue;

    for (const supersededId of group.supersededIds) {
      const older = documentsById.get(supersededId);
      if (!older) continue;

      const latestYear = validYear(latest);
      const olderYear = validYear(older);
      const hasSharedSubject = older.subjects.some((subject) => latest.subjects.includes(subject));
      const latestCoversOlderLevels = older.educationLevels.length > 0 &&
        older.educationLevels.every((level) => latest.educationLevels.includes(level));
      if (
        latestYear === null ||
        olderYear === null ||
        latestYear <= olderYear ||
        !hasSharedSubject ||
        !latestCoversOlderLevels
      ) {
        continue;
      }

      excludedById.set(older.id, {
        id: older.id,
        valid: older.valid,
        supersededBy: latest.id,
        supersededByValid: latest.valid,
      });
    }
  }

  return {
    documents: documents.filter((document) => !excludedById.has(document.id)),
    excludedDocuments: documents
      .filter((document) => excludedById.has(document.id))
      .map((document) => excludedById.get(document.id)),
    policy: groups.length ? "curated" : "all-listed",
  };
}

/**
 * Fetch and normalize all curriculum documents listed for an ASN jurisdiction.
 * The returned object is a compact, JSON-serializable representation of the
 * current curriculum statements and their document-level scope.
 */
export async function importCurriculumRequirements(jurisdiction, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof jurisdiction !== "string" || !/^[A-Za-z0-9-]+$/.test(jurisdiction)) {
    throw new Error("Jurisdiction must be a non-empty ASN jurisdiction code, such as CAN-ON.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required to contact the ASN catalog.");
  }

  const catalogUrl = `${ASN_ORIGIN}/resources/ASNJurisdiction/${encodeURIComponent(jurisdiction)}`;
  const catalogHtml = await fetchText(fetchImpl, catalogUrl, `${jurisdiction} catalog`);
  const catalogEntries = parseCatalog(catalogHtml, jurisdiction);
  const documents = new Array(catalogEntries.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < catalogEntries.length) {
      const index = nextIndex++;
      const entry = catalogEntries[index];
      const documentUrl = `${ASN_ORIGIN}/resources/${entry.id}_full.json`;
      const documentText = await fetchText(fetchImpl, documentUrl, `document ${entry.id}`);
      let resources;
      try {
        resources = JSON.parse(documentText);
      } catch (error) {
        throw new Error(`ASN document ${entry.id} contained invalid JSON.`, { cause: error });
      }
      documents[index] = summarizeDocument(entry, resources);
    }
  };

  const workerCount = Math.min(MAX_CONCURRENT_DOWNLOADS, catalogEntries.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const selection = applyCuratedVersions(jurisdiction, documents);
  const includedDocuments = selection.documents;
  const statementCounts = {};
  let statementCount = 0;
  let incompleteStatementCount = 0;
  for (const document of includedDocuments) {
    for (const statement of document.statements) {
      statementCount++;
      const label = statement.label ?? "(unlabeled)";
      statementCounts[label] = (statementCounts[label] ?? 0) + 1;
      if (!statement.label || statement.text === null) {
        incompleteStatementCount++;
      }
    }
  }

  return {
    schemaVersion: 1,
    jurisdiction,
    catalogUrl,
    fetchedAt: new Date().toISOString(),
    versionPolicy: selection.policy,
    catalogDocumentCount: catalogEntries.length,
    documentCount: includedDocuments.length,
    excludedDocumentCount: selection.excludedDocuments.length,
    excludedDocuments: selection.excludedDocuments,
    statementCount,
    incompleteStatementCount,
    statementCounts,
    documents: includedDocuments,
  };
}
