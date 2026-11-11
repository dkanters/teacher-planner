import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { importCurriculumRequirements } from "./curriculumImporter.mjs";

const [jurisdiction, outputArgument, ...extraArguments] = process.argv.slice(2);
if (!jurisdiction || extraArguments.length > 0) {
  console.error("Usage: node scripts/importCurriculum.mjs <jurisdiction> [output-file]");
  process.exitCode = 2;
} else {
  try {
    const outputPath = path.resolve(outputArgument ?? `curriculum-${jurisdiction}-summary.json`);
    const summary = await importCurriculumRequirements(jurisdiction);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(summary)}\n`, { flag: "wx" });
    console.log(
      `Imported ${summary.documentCount} documents and ${summary.statementCount} statements for ${jurisdiction}.`,
    );
    console.log(`Wrote ${outputPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
