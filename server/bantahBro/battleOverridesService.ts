import fs from "node:fs/promises";
import path from "node:path";

export type BantahBroBattleOverridePatch = {
  hidden?: boolean;
  pinned?: boolean;
  featured?: boolean;
  note?: string | null;
  updatedBy?: number | string | null;
};

export type BantahBroBattleOverride = {
  battleId: string;
  hidden: boolean;
  pinned: boolean;
  featured: boolean;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string;
};

type OverrideStore = {
  version: 1;
  overrides: Record<string, BantahBroBattleOverride>;
};

const STORE_PATH = path.resolve(process.cwd(), "cache", "bantahbro-battle-overrides.json");

let cachedStore: OverrideStore | null = null;

function emptyStore(): OverrideStore {
  return { version: 1, overrides: {} };
}

function normalizeBattleId(value: string) {
  return String(value || "").trim().slice(0, 220);
}

function normalizeStore(payload: unknown): OverrideStore {
  if (!payload || typeof payload !== "object") return emptyStore();
  const raw = payload as Partial<OverrideStore>;
  const overrides =
    raw.overrides && typeof raw.overrides === "object"
      ? Object.fromEntries(
          Object.entries(raw.overrides).filter(([id, value]) => {
            return Boolean(normalizeBattleId(id)) && Boolean(value && typeof value === "object");
          }),
        )
      : {};
  return { version: 1, overrides: overrides as Record<string, BantahBroBattleOverride> };
}

async function readStore(): Promise<OverrideStore> {
  if (cachedStore) return cachedStore;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    cachedStore = normalizeStore(JSON.parse(raw));
  } catch {
    cachedStore = emptyStore();
  }
  return cachedStore;
}

async function writeStore(store: OverrideStore) {
  cachedStore = store;
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

export async function listBantahBroBattleOverrides() {
  const store = await readStore();
  return Object.values(store.overrides).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getBantahBroBattleOverrideMap() {
  const store = await readStore();
  return new Map(Object.entries(store.overrides));
}

export async function updateBantahBroBattleOverride(battleIdInput: string, patch: BantahBroBattleOverridePatch) {
  const battleId = normalizeBattleId(battleIdInput);
  if (!battleId) {
    throw new Error("Battle ID is required");
  }

  const store = await readStore();
  const previous = store.overrides[battleId];
  const updated: BantahBroBattleOverride = {
    battleId,
    hidden: patch.hidden ?? previous?.hidden ?? false,
    pinned: patch.pinned ?? previous?.pinned ?? false,
    featured: patch.featured ?? previous?.featured ?? false,
    note:
      patch.note === undefined
        ? previous?.note ?? null
        : patch.note
          ? String(patch.note).trim().slice(0, 500)
          : null,
    updatedBy:
      patch.updatedBy === undefined
        ? previous?.updatedBy ?? null
        : patch.updatedBy === null
          ? null
          : String(patch.updatedBy),
    updatedAt: new Date().toISOString(),
  };

  if (!updated.hidden && !updated.pinned && !updated.featured && !updated.note) {
    delete store.overrides[battleId];
    await writeStore(store);
    return { battleId, hidden: false, pinned: false, featured: false, note: null, updatedBy: null, updatedAt: updated.updatedAt };
  }

  store.overrides[battleId] = updated;
  await writeStore(store);
  return updated;
}
