type StoredAgent = {
  id: string;
  name: string;
  username?: string;
  system?: string;
  bio?: string | string[];
  settings?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

type StoredEntity = {
  id: string;
  agentId: string;
  names: string[];
  metadata: Record<string, unknown>;
  components?: unknown[];
};

type StoredRoom = {
  id: string;
  worldId?: string;
  agentId?: string;
  name?: string;
  source?: string;
  type?: string;
  channelId?: string;
  serverId?: string;
  metadata?: Record<string, unknown>;
};

type StoredWorld = {
  id: string;
  agentId?: string;
  name?: string;
  serverId?: string;
  metadata?: Record<string, unknown>;
};

type WorldMetadata = {
  ownership?: {
    ownerId?: string;
  };
  roles?: Record<string, string>;
  settings?: Record<string, unknown>;
} & Record<string, unknown>;

export class BantahElizaRuntimeMemoryAdapter {
  db = null;
  private agents = new Map<string, StoredAgent>();
  private entities = new Map<string, StoredEntity>();
  private worlds = new Map<string, StoredWorld>();
  private rooms = new Map<string, StoredRoom>();
  private memories = new Map<string, any>();
  private roomParticipants = new Map<string, Set<string>>();
  private participantStates = new Map<string, "FOLLOWED" | "MUTED" | null>();

  private ensureDirectMessageWorldOwnership(roomId: string, participantIds: string[]) {
    const room = this.rooms.get(roomId);
    if (!room || room.type !== "DM" || !room.worldId) {
      return;
    }

    const world = this.worlds.get(room.worldId);
    if (!world) {
      return;
    }

    const existingMetadata = (world.metadata ?? {}) as WorldMetadata;
    const existingOwnerId = existingMetadata.ownership?.ownerId;
    const nonAgentParticipantId =
      participantIds.find((participantId) => participantId && participantId !== room.agentId) ??
      Array.from(this.roomParticipants.get(roomId) ?? []).find(
        (participantId) => participantId && participantId !== room.agentId,
      );

    if (!nonAgentParticipantId) {
      return;
    }

    const nextServerId =
      typeof world.serverId === "string" && world.serverId.trim() && world.serverId !== "default"
        ? world.serverId
        : room.channelId || room.id;

    const nextMetadata: WorldMetadata = {
      ...existingMetadata,
      ownership: {
        ...(existingMetadata.ownership ?? {}),
        ownerId: existingOwnerId || nonAgentParticipantId,
      },
      roles: {
        ...(existingMetadata.roles ?? {}),
        [nonAgentParticipantId]: existingMetadata.roles?.[nonAgentParticipantId] || "OWNER",
      },
      settings:
        existingMetadata.settings && typeof existingMetadata.settings === "object"
          ? existingMetadata.settings
          : {},
    };

    this.worlds.set(room.worldId, {
      ...world,
      serverId: nextServerId,
      metadata: nextMetadata,
    });
  }

  async initialize() {}
  async init() {}
  async runMigrations() {}
  async isReady() {
    return true;
  }
  async close() {}
  async getConnection() {
    return null;
  }

  async getAgent(agentId: string) {
    return this.agents.get(agentId) ?? null;
  }

  async getAgents() {
    return Array.from(this.agents.values()).map((agent) => ({
      id: agent.id,
      name: agent.name,
      bio: agent.bio ?? "",
    }));
  }

  async createAgent(agent: Partial<StoredAgent>) {
    if (!agent.id || !agent.name) return false;
    if (this.agents.has(agent.id)) return false;

    this.agents.set(agent.id, {
      id: agent.id,
      name: agent.name,
      username: agent.username,
      system: agent.system,
      bio: agent.bio ?? "",
      settings: agent.settings ?? {},
      createdAt: typeof agent.createdAt === "number" ? agent.createdAt : Date.now(),
      updatedAt: typeof agent.updatedAt === "number" ? agent.updatedAt : Date.now(),
    });
    return true;
  }

  async updateAgent(agentId: string, agent: Partial<StoredAgent>) {
    const existing = this.agents.get(agentId);
    if (!existing) return false;
    this.agents.set(agentId, {
      ...existing,
      ...agent,
      id: agentId,
      updatedAt: Date.now(),
    });
    return true;
  }

  async deleteAgent(agentId: string) {
    return this.agents.delete(agentId);
  }

  async ensureEmbeddingDimension() {}

  async getEntitiesByIds(entityIds: string[]) {
    const items = entityIds
      .map((id) => this.entities.get(id))
      .filter(Boolean) as StoredEntity[];
    return items.length ? items : null;
  }

  async getEntitiesForRoom(roomId?: string) {
    if (!roomId) return [];
    const participantIds = Array.from(this.roomParticipants.get(roomId) ?? []);
    return participantIds
      .map((participantId) => this.entities.get(participantId))
      .filter(Boolean);
  }

  async createEntities(entities: StoredEntity[]) {
    for (const entity of entities) {
      this.entities.set(entity.id, {
        ...entity,
        components: entity.components ?? [],
        metadata: entity.metadata ?? {},
      });
    }
    return true;
  }

  async updateEntity(entity: StoredEntity) {
    this.entities.set(entity.id, {
      ...entity,
      components: entity.components ?? [],
      metadata: entity.metadata ?? {},
    });
  }

  async getComponent() {
    return null;
  }

  async getComponents() {
    return [];
  }

  async createComponent() {
    return true;
  }

  async updateComponent() {}

  async deleteComponent() {}

  async getMemories() {
    return [];
  }

  async getMemoriesByRoomIds() {
    return [];
  }

  async getMemoryById(memoryId: string) {
    return this.memories.get(memoryId) ?? null;
  }

  async createMemory(memory: any) {
    this.memories.set(memory.id, memory);
    return memory;
  }

  async updateMemory(memory: any) {
    this.memories.set(memory.id, memory);
    return true;
  }

  async removeMemory(memoryId: string) {
    this.memories.delete(memoryId);
  }

  async removeAllMemories() {
    this.memories.clear();
  }

  async countMemories() {
    return this.memories.size;
  }

  async searchMemories() {
    return [];
  }

  async getCachedEmbeddings() {
    return [];
  }

  async log() {}

  async getRoom(roomId: string) {
    return this.rooms.get(roomId) ?? null;
  }

  async getRoomsByIds(roomIds: string[]) {
    return roomIds
      .map((id) => this.rooms.get(id))
      .filter(Boolean);
  }

  async getRooms(worldId?: string) {
    if (!worldId) {
      return Array.from(this.rooms.values());
    }
    return Array.from(this.rooms.values()).filter((room) => room.worldId === worldId);
  }

  async createRoom(room: StoredRoom) {
    this.rooms.set(room.id, room);
    return room.id;
  }

  async createRooms(rooms: StoredRoom[]) {
    for (const room of rooms) {
      this.rooms.set(room.id, room);
    }
    return rooms.map((room) => room.id);
  }

  async updateRoom(roomOrRoomId: string | StoredRoom, updates?: Partial<StoredRoom>) {
    const roomId = typeof roomOrRoomId === "string" ? roomOrRoomId : roomOrRoomId.id;
    const existing = this.rooms.get(roomId);
    if (!existing) return null;
    const next =
      typeof roomOrRoomId === "string"
        ? { ...existing, ...(updates ?? {}), id: roomId }
        : { ...existing, ...roomOrRoomId, id: roomId };
    this.rooms.set(roomId, next);
    return next;
  }

  async deleteRoom(roomId: string) {
    this.rooms.delete(roomId);
  }

  async deleteRoomsByWorldId(worldId: string) {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.worldId === worldId) {
        this.rooms.delete(roomId);
        this.roomParticipants.delete(roomId);
      }
    }
  }

  async getRoomsForParticipant(entityId: string) {
    const roomIds: string[] = [];
    for (const [roomId, participants] of this.roomParticipants.entries()) {
      if (participants.has(entityId)) {
        roomIds.push(roomId);
      }
    }
    return roomIds;
  }

  async getRoomsForParticipants(entityIds: string[]) {
    const roomIds = new Set<string>();
    for (const entityId of entityIds) {
      for (const roomId of await this.getRoomsForParticipant(entityId)) {
        roomIds.add(roomId);
      }
    }
    return Array.from(roomIds);
  }

  async addParticipants() {}

  async addParticipantsRoom(participantIds: string[], roomId: string) {
    const current = this.roomParticipants.get(roomId) ?? new Set<string>();
    for (const participantId of participantIds) {
      current.add(participantId);
    }
    this.roomParticipants.set(roomId, current);
    this.ensureDirectMessageWorldOwnership(roomId, participantIds);
    return true;
  }

  async removeParticipant() {}

  async removeParticipantsRoom(participantIds: string[], roomId: string) {
    const current = this.roomParticipants.get(roomId);
    if (!current) return true;
    for (const participantId of participantIds) {
      current.delete(participantId);
    }
    return true;
  }

  async getParticipantsForEntity() {
    return [];
  }

  async getParticipantsForRoom(roomId: string) {
    return Array.from(this.roomParticipants.get(roomId) ?? []);
  }

  async createRelationship() {
    return true;
  }

  async createWorld(world: StoredWorld) {
    this.worlds.set(world.id, {
      ...world,
      metadata: world.metadata ?? {},
    });
    return world.id;
  }

  async getWorld(id: string) {
    return this.worlds.get(id) ?? null;
  }

  async removeWorld(worldId: string) {
    this.worlds.delete(worldId);
    await this.deleteRoomsByWorldId(worldId);
  }

  async getAllWorlds() {
    return Array.from(this.worlds.values());
  }

  async updateWorld(world: StoredWorld) {
    const existing = this.worlds.get(world.id);
    this.worlds.set(world.id, {
      ...(existing ?? {}),
      ...world,
      metadata: world.metadata ?? existing?.metadata ?? {},
    });
  }

  async getRoomsByWorld(worldId: string) {
    return Array.from(this.rooms.values()).filter((room) => room.worldId === worldId);
  }

  async getParticipantUserState(roomId: string, entityId: string) {
    return this.participantStates.get(`${roomId}:${entityId}`) ?? null;
  }

  async setParticipantUserState(
    roomId: string,
    entityId: string,
    state: "FOLLOWED" | "MUTED" | null,
  ) {
    this.participantStates.set(`${roomId}:${entityId}`, state);
  }

  async getRelationships() {
    return [];
  }

  async createCache() {
    return true;
  }

  async getCache() {
    return null;
  }

  async deleteCache() {
    return true;
  }

  async getTasks() {
    return [];
  }

  async createTask() {
    return true;
  }

  async updateTask() {
    return true;
  }

  async deleteTask() {
    return true;
  }
}
