import fs from "node:fs";
import path from "node:path";

const packagePath = path.join(process.cwd(), "package.json");
const lockPath = path.join(process.cwd(), "package-lock.json");

const packageJson = readJson(packagePath);
const packageName = requireString(packageJson.name, "package.json name");
const packageVersion = requireString(packageJson.version, "package.json version");

if (process.argv.includes("--check")) {
  assertSemver(packageVersion);
  assertLockfileVersion(packageVersion);
  console.log(`version available: ${packageName}@${packageVersion}`);
} else {
  console.log(`${packageName}@${packageVersion}`);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path.relative(process.cwd(), filePath)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is not available.`);
  }
  return value;
}

function assertSemver(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`package.json version must be SemVer, got ${version}.`);
  }
}

function assertLockfileVersion(version) {
  if (!fs.existsSync(lockPath)) {
    return;
  }

  const lockJson = readJson(lockPath);
  const lockRootVersion = lockJson.packages?.[""]?.version;
  const lockVersion = lockRootVersion || lockJson.version;
  if (lockVersion !== version) {
    throw new Error(`package-lock.json version ${lockVersion} does not match package.json version ${version}.`);
  }
}
