import {
  createActionResult,
  type Action,
  type IAgentRuntime,
  type Plugin,
} from "@elizaos/core";
import {
  BANTAH_SKILL_VERSION,
  agentActionEnvelopeSchema,
  bantahRequiredSkillActionValues,
  type BantahRequiredSkillAction,
} from "@shared/agentSkill";
import {
  executeBantahSkillEnvelope,
  serializeBantahSkillError,
} from "./bantahAgentSkillExecutor";

export const BANTAH_ELIZA_SKILLS_PLUGIN_NAME = "bantah-managed-skills";

function getRuntimeAgentId(runtime: IAgentRuntime): string | null {
  const runtimeSetting = runtime.getSetting("BANTAH_AGENT_ID");
  if (typeof runtimeSetting === "string" && runtimeSetting.trim()) {
    return runtimeSetting.trim();
  }

  const characterSetting = (runtime.character?.settings as Record<string, unknown> | undefined)
    ?.BANTAH_AGENT_ID;
  if (typeof characterSetting === "string" && characterSetting.trim()) {
    return characterSetting.trim();
  }

  if (typeof runtime.character?.id === "string" && runtime.character.id.trim()) {
    return runtime.character.id.trim();
  }

  return null;
}

function getEnabledSkillActions(runtime: IAgentRuntime): Set<string> {
  const raw =
    runtime.getSetting("BANTAH_SKILL_ACTIONS") ??
    (runtime.character?.settings as Record<string, unknown> | undefined)?.BANTAH_SKILL_ACTIONS;

  if (Array.isArray(raw)) {
    return new Set(
      raw
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    );
  }

  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(
          parsed
            .map((value) => (typeof value === "string" ? value.trim() : ""))
            .filter(Boolean),
        );
      }
    } catch {
      return new Set(
        raw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
    }
  }

  return new Set();
}

function buildActionDescription(actionName: BantahRequiredSkillAction) {
  switch (actionName) {
    case "create_market":
      return "Create a Bantah market using the managed agent wallet and saved Bantah runtime config.";
    case "create_p2p_market":
      return "Create an escrow-locked Bantah P2P market challenge with the managed agent wallet.";
    case "join_yes":
      return "Join a Bantah market on the YES side with the agent wallet and Bantah execution rules.";
    case "join_no":
      return "Join a Bantah market on the NO side with the agent wallet and Bantah execution rules.";
    case "read_market":
      return "Read the latest Bantah market snapshot, pricing context, and participants for a market.";
    case "check_balance":
      return "Check the Bantah agent wallet balance for a supported token and chain.";
    default:
      return "Execute a Bantah managed skill action.";
  }
}

function createBantahSkillAction(actionName: BantahRequiredSkillAction): Action {
  return {
    name: actionName,
    similes: [actionName.toUpperCase()],
    description: buildActionDescription(actionName),
    validate: async (runtime) => {
      const agentId = getRuntimeAgentId(runtime);
      if (!agentId) return false;

      const enabledActions = getEnabledSkillActions(runtime);
      return enabledActions.size === 0 || enabledActions.has(actionName);
    },
    handler: async (runtime, _message, _state, options) => {
      const fallbackRequestId = `eliza_${actionName}_${Date.now()}`;
      const requestId =
        typeof options?.requestId === "string" && options.requestId.trim().length > 0
          ? options.requestId.trim()
          : fallbackRequestId;
      const agentId = getRuntimeAgentId(runtime);

      if (!agentId) {
        const response = serializeBantahSkillError(
          requestId,
          new Error("Managed Bantah agent id is missing from the Eliza runtime."),
        );
        return createActionResult({
          success: false,
          error: response.envelope.error.message,
          data: {
            status: response.status,
            envelope: response.envelope,
          },
        });
      }

      const payload =
        options?.payload && typeof options.payload === "object"
          ? (options.payload as Record<string, unknown>)
          : {};

      const envelope = agentActionEnvelopeSchema.parse({
        action: actionName,
        skillVersion: BANTAH_SKILL_VERSION,
        requestId,
        timestamp: new Date().toISOString(),
        payload,
      });

      try {
        const successEnvelope = await executeBantahSkillEnvelope(agentId, envelope);
        return createActionResult({
          success: true,
          text:
            typeof successEnvelope.result === "object"
              ? JSON.stringify(successEnvelope.result)
              : String(successEnvelope.result ?? ""),
          data: {
            status: 200,
            envelope: successEnvelope,
          },
        });
      } catch (error) {
        const response = serializeBantahSkillError(requestId, error);
        return createActionResult({
          success: false,
          error: response.envelope.error.message,
          data: {
            status: response.status,
            envelope: response.envelope,
          },
        });
      }
    },
  };
}

export function createBantahElizaSkillsPlugin(
  enabledActions: readonly string[] = bantahRequiredSkillActionValues,
): Plugin {
  const enabled = new Set(enabledActions.map((action) => String(action || "").trim()).filter(Boolean));
  const actions = bantahRequiredSkillActionValues
    .filter((actionName) => enabled.size === 0 || enabled.has(actionName))
    .map((actionName) => createBantahSkillAction(actionName));

  return {
    name: BANTAH_ELIZA_SKILLS_PLUGIN_NAME,
    description: "Bantah-managed market actions exposed to Eliza runtimes as first-class tools.",
    actions,
  };
}
