import { test } from "node:test";
import assert from "node:assert/strict";
import { importCurriculumRequirements } from "../scripts/curriculumImporter.mjs";

const asn = "http://asn.desire2learn.com/resources/";
const rdfType = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const schema = "http://purl.org/ASN/schema/core/";
const dcterms = "http://purl.org/dc/terms/";
const gem = "http://purl.org/gem/qualifiers/";

function response(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

function documentJson(id: string, title: string, statements: Record<string, unknown>[]) {
  return {
    [`${asn}${id}`]: {
      [rdfType]: [{ value: `${schema}StandardDocument`, type: "uri" }],
      [`${dcterms}title`]: [{ value: title, type: "literal", lang: "en-ca" }],
      [`${dcterms}source`]: [{ value: "https://example.test/curriculum", type: "uri" }],
      [`${dcterms}subject`]: [{ value: "http://purl.org/ASN/scheme/ASNTopic_CAN-ON/kindergartenProgram", type: "uri" }],
      [`${dcterms}educationLevel`]: [{ value: "http://purl.org/ASN/scheme/ASNEducationLevel_CAN-ON/K", type: "uri" }],
    },
    ...Object.fromEntries(statements.map((statement, index) => [`${asn}S${id.slice(1)}-${index}`, statement])),
  };
}

function versionedDocument(
  id: string,
  title: string,
  valid: string,
  subject: string,
  educationLevel: string,
) {
  return {
    [`${asn}${id}`]: {
      [rdfType]: [{ value: `${schema}StandardDocument`, type: "uri" }],
      [`${dcterms}title`]: [{ value: title, type: "literal" }],
      [`${dcterms}valid`]: [{ value: valid, type: "literal" }],
      [`${dcterms}subject`]: [{ value: subject, type: "uri" }],
      [`${dcterms}educationLevel`]: [{ value: educationLevel, type: "uri" }],
    },
  };
}

function statement(label: string, text: string, parentId: string, code?: string) {
  return {
    [rdfType]: [{ value: `${schema}Statement`, type: "uri" }],
    [`${dcterms}description`]: [{ value: text, type: "literal", lang: "en-ca" }],
    [`${dcterms}subject`]: [{ value: "http://purl.org/ASN/scheme/ASNTopic_CAN-ON/mathematics", type: "uri" }],
    [`${dcterms}educationLevel`]: [{ value: "http://purl.org/ASN/scheme/ASNEducationLevel_CAN-ON/1", type: "uri" }],
    [`${dcterms}language`]: [{ value: "http://id.loc.gov/vocabulary/iso639-2/eng", type: "uri" }],
    [`${schema}statementLabel`]: [{ value: label, type: "literal", lang: "en-ca" }],
    ...(code ? { [`${schema}statementNotation`]: [{ value: code, type: "literal" }] } : {}),
    [`${gem}isChildOf`]: [{ value: `${asn}${parentId}`, type: "uri" }],
  };
}

test("imports every catalog entry into one normalized jurisdiction summary", async () => {
  const catalogUrl = "https://asn.desire2learn.com/resources/ASNJurisdiction/CAN-ON";
  const catalog = [
    { title: "First curriculum", status: "Published", year: "2026", link: "D100" },
    { title: "Second curriculum", status: "Published", year: "2024", link: "D200" },
  ];
  const responses = new Map([
    [catalogUrl, response(`<script>const STATES = ${JSON.stringify(catalog)};</script>`)],
    [
      "https://asn.desire2learn.com/resources/D100_full.json",
      response(JSON.stringify(documentJson("D100", "First curriculum", [
        statement("Overall Expectation", "Communicate clearly.", "S100", "O.A1"),
        statement("Specific Expectation", "Listen and respond.", "S100", "A1.1"),
        {
          [rdfType]: [{ value: `${schema}Statement`, type: "uri" }],
          [`${dcterms}description`]: [{ value: "A curriculum heading without a label.", type: "literal" }],
          [`${gem}isChildOf`]: [{ value: `${asn}S100`, type: "uri" }],
        },
      ]))),
    ],
    [
      "https://asn.desire2learn.com/resources/D200_full.json",
      response(JSON.stringify(documentJson("D200", "Second curriculum", [
        statement("Strand", "Foundations of learning.", "D200"),
      ]))),
    ],
  ]);
  const requested: string[] = [];
  const fetchMock = async (url: string) => {
    requested.push(url);
    const result = responses.get(url);
    assert.ok(result, `Unexpected request: ${url}`);
    return result;
  };

  const result = await importCurriculumRequirements("CAN-ON", { fetchImpl: fetchMock });

  assert.equal(result.jurisdiction, "CAN-ON");
  assert.equal(result.documentCount, 2);
  assert.equal(result.statementCount, 4);
  assert.equal(result.incompleteStatementCount, 1);
  assert.deepEqual(result.statementCounts, {
    "Overall Expectation": 1,
    "Specific Expectation": 1,
    Strand: 1,
    "(unlabeled)": 1,
  });
  assert.equal(result.documents[0].statements[1].id, "S100-1");
  assert.equal(result.documents[0].statements[1].parentIds[0], "S100");
  assert.equal(result.documents[0].statements[1].code, "A1.1");
  assert.equal(result.documents[1].statements[0].code, null);
  assert.equal(result.documents[0].statements[2].label, null);
  assert.equal(result.documents[0].statements[2].text, "A curriculum heading without a label.");
  assert.deepEqual(result.documents[0].subjects, ["kindergartenProgram"]);
  assert.deepEqual(result.documents[0].educationLevels, ["K"]);
  assert.deepEqual(result.documents[0].statements[0].languageUris, ["eng"]);
  assert.deepEqual(result.documents[0].statements[1].subjects, ["mathematics"]);
  assert.deepEqual(result.documents[0].statements[1].educationLevels, ["1"]);
  for (const key of ["description", "statementCount", "incompleteStatementCount", "statementCounts"]) {
    assert.equal(Object.hasOwn(result.documents[0], key), false);
  }
  assert.equal("sourceResources" in result.documents[0], false);
  assert.equal("parentUris" in result.documents[0].statements[1], false);
  assert.equal("authorityStatus" in result.documents[0].statements[1], false);
  assert.equal(requested.length, 3);
});

test("reports failed downloads instead of returning a partial import", async () => {
  const catalogUrl = "https://asn.desire2learn.com/resources/ASNJurisdiction/CAN-ON";
  const fetchMock = async (url: string) => {
    if (url === catalogUrl) {
      return response(`<script>const STATES = ${JSON.stringify([
        { title: "Unavailable curriculum", status: "Published", year: "2026", link: "D300" },
      ])};</script>`);
    }
    return response("Not found", 404);
  };

  await assert.rejects(
    importCurriculumRequirements("CAN-ON", { fetchImpl: fetchMock }),
    /document D300: HTTP 404/,
  );
});

test("curated version groups exclude only a newer, matching version and keep distinct courses", async () => {
  const catalogUrl = "https://asn.desire2learn.com/resources/ASNJurisdiction/CAN-ON";
  const kindergartenSubject = "http://purl.org/ASN/scheme/ASNTopic_CAN-ON/kindergartenProgram";
  const scienceSubject = "http://purl.org/ASN/scheme/ASNTopic_CAN-ON/science";
  const kindergartenLevel = "http://purl.org/ASN/scheme/ASNEducationLevel_CAN-ON/K";
  const gradeNine = "http://purl.org/ASN/scheme/ASNEducationLevel_CAN-ON/9";
  const catalog = [
    { title: "Ontario Kindergarten Curriculum", status: "Published", year: "2026", link: "D21699313" },
    { title: "The Kindergarten Program", status: "Published", year: "2019", link: "D2754782" },
    { title: "Science Grade 9", status: "Published", year: "2022", link: "D21272309" },
    { title: "Locally Developed Science Grade 9", status: "Published", year: "2005", link: "D21084835" },
  ];
  const payloads = new Map([
    ["D21699313", versionedDocument("D21699313", catalog[0].title, "2026", kindergartenSubject, kindergartenLevel)],
    ["D2754782", versionedDocument("D2754782", catalog[1].title, "2019", kindergartenSubject, kindergartenLevel)],
    ["D21272309", versionedDocument("D21272309", catalog[2].title, "2022", scienceSubject, gradeNine)],
    ["D21084835", versionedDocument("D21084835", catalog[3].title, "2005", scienceSubject, gradeNine)],
  ]);
  const responses = new Map([
    [catalogUrl, response(`<script>const STATES = ${JSON.stringify(catalog)};</script>`)],
    ...Array.from(payloads, ([id, payload]) => [
      `https://asn.desire2learn.com/resources/${id}_full.json`,
      response(JSON.stringify(payload)),
    ]),
  ]);
  const fetchMock = async (url: string) => {
    const result = responses.get(url);
    assert.ok(result, `Unexpected request: ${url}`);
    return result;
  };

  const result = await importCurriculumRequirements("CAN-ON", { fetchImpl: fetchMock });

  assert.equal(result.versionPolicy, "curated");
  assert.equal(result.catalogDocumentCount, 4);
  assert.equal(result.documentCount, 3);
  assert.equal(result.excludedDocumentCount, 1);
  assert.equal(result.excludedDocuments[0].id, "D2754782");
  assert.equal(result.excludedDocuments[0].supersededBy, "D21699313");
  assert.deepEqual(result.documents.map((document: { id: string }) => document.id), [
    "D21699313",
    "D21272309",
    "D21084835",
  ]);
});
