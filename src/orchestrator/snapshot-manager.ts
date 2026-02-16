import * as fs from "fs";
import * as path from "path";

const SNAPSHOT_FILE = path.join(process.cwd(), ".snapshot-id");

/**
 * Read the snapshot ID from the .snapshot-id file.
 * Returns null if file doesn't exist or is empty.
 */
export function getSnapshotId(): string | null {
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    console.log("[Snapshot] No .snapshot-id file found");
    return null;
  }

  const id = fs.readFileSync(SNAPSHOT_FILE, "utf-8").trim();

  if (!id) {
    console.log("[Snapshot] .snapshot-id file is empty");
    return null;
  }

  console.log(`[Snapshot] Using snapshot: ${id}`);
  return id;
}

/**
 * Save a snapshot ID to the .snapshot-id file.
 */
export function saveSnapshotId(id: string): void {
  fs.writeFileSync(SNAPSHOT_FILE, id, "utf-8");
  console.log(`[Snapshot] Saved snapshot ID: ${id}`);
}
