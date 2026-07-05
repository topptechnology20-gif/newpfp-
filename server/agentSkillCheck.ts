import { randomUUID } from "crypto";
import { z } from "zod";
import type {
  AgentSkillCheckActionResult,
  AgentSkillCheckResult,
} from "@shared/agentApi";
import { agentSkillCheckResultSchema } from "@shared/agentApi";
import {
  BANTAH_SKILL_VERSION,
  checkBalanceResultSchema,
  createMarketResultSchema,
  joinMarketResultSchema,
  readMarketResultSchema,
  skillErrorSchema,
  skillSuccessEnvelopeSchema,
  type BantahRequiredSkillAction,
  type BantahSkillErrorCode,
} from "@shared/agentSkill";

const SKILL_CHECK_TIMEOUT_MS = 8_000;

type SkillCheckCase = {
  action: BantahRequiredSkillAction;
  payload: Record<string, unknown>;
  successSchema: z.ZodTypeAny;
  allowSuccess: boolean;
  allowedErrorCodes: BantahSkillErrorCode[];
  expectedSide?: "yes" | "no";
};

const skillCheckCases: SkillCheckCase[] = [
  {
    action: "create_market",
    payload: {
      question: "Bantah skill check: reject expired market creation",
      options: ["Yes", "No"],
      deadline: new Date(Date.now() - 60_000).toISOString(),
      stakeAmount: "1",
      currency: "USDC",
      chainId: 8453,
    },
    successSchema: createMarketResultSchema,
    allowSuccess: false,
    allowedErrorCodes: ["invalid_input"],
  },
  {
    action: "join_yes",
    payload: {
      marketId: "bantah_skillcheck_missing_market",
      stakeAmount: "1",
    },
    successSchema: joinMarketResultSchema,
    allowSuccess: false,
    allowedErrorCodes: ["invalid_input", "market_closed"],
    expectedSide: "yes",
  },
  {
    action: "join_no",
    payload: {
      marketId: "bantah_skillcheck_missing_market",
      stakeAmount: "1",
    },
    successSchema: joinMarketResultSchema,
    allowSuccess: false,
    allowedErrorCodes: ["invalid_input", "market_closed"],
    expectedSide: "no",
  },
  {
    action: "read_market",
    payload: {
      marketId: "bantah_skillcheck_missing_market",
    },
    successSchema: readMarketResultSchema,
    allowSuccess: true,
    allowedErrorCodes: ["invalid_input"],
  },
  {
    action: "check_balance",
    payload: {
      currency: "USDC",
      chainId: 8453,
    },
    successSchema: checkBalanceResultSchema,
    allowSuccess: true,
    allowedErrorCodes: [],
  },
];

function buildEnvelope(action: BantahRequiredSkillAction, payload: Record<string, unknown>) {
  return {
    action,
    skillVersion: BANTAH_SKILL_VERSION,
    requestId: `skillcheck_${action}_${randomUUID()}`,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function buildInvalidResult(
  action: BantahRequiredSkillAction,
  durationMs: number,
  statusCode: number | null,
  message: string,
): AgentSkillCheckActionResult {
  return {
    action,
    passed: false,
    ok: false,
    responseType: "invalid",
    statusCode,
    durationMs,
    message,
  };
}

async function runSkillCheckCase(
  endpointUrl: string,
  config: SkillCheckCase,
): Promise<AgentSkillCheckActionResult> {
  const startedAt = Date.now();
  const request = buildEnvelope(config.action, config.payload);

  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "BantahSkillCheck/1.0",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(SKILL_CHECK_TIMEOUT_MS),
    });

    const durationMs = Date.now() - startedAt;
    const rawBody = await response.text();

    let parsedBody: unknown;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return buildInvalidResult(
        config.action,
        durationMs,
        response.status,
        "Agent endpoint did not return valid JSON.",
      );
    }

    const successEnvelope = skillSuccessEnvelopeSchema.safeParse(parsedBody);
    if (successEnvelope.success) {
      if (!config.allowSuccess) {
        return {
          action: config.action,
          passed: false,
          ok: true,
          responseType: "success",
          statusCode: response.status,
          durationMs,
          message: "Action returned success for a validation-only skill check.",
        };
      }

      const typedResult = config.successSchema.safeParse(successEnvelope.data.result);
      if (!typedResult.success) {
        return buildInvalidResult(
          config.action,
          durationMs,
          response.status,
          "Success response did not match the Bantah result schema.",
        );
      }

      if (config.expectedSide && typedResult.data?.side !== config.expectedSide) {
        return buildInvalidResult(
          config.action,
          durationMs,
          response.status,
          `Expected side ${config.expectedSide} but received ${typedResult.data?.side ?? "unknown"}.`,
        );
      }

      return {
        action: config.action,
        passed: true,
        ok: true,
        responseType: "success",
        statusCode: response.status,
        durationMs,
        message: "Action returned a valid Bantah success payload.",
      };
    }

    const errorEnvelope = skillErrorSchema.safeParse(parsedBody);
    if (errorEnvelope.success) {
      const code = errorEnvelope.data.error.code;
      const passed = config.allowedErrorCodes.includes(code);

      return {
        action: config.action,
        passed,
        ok: false,
        responseType: "error",
        statusCode: response.status,
        durationMs,
        message: passed
          ? `Action returned an accepted Bantah error response: ${code}.`
          : `Action returned Bantah error code ${code}, which does not satisfy this skill check.`,
      };
    }

    return buildInvalidResult(
      config.action,
      durationMs,
      response.status,
      "Response did not match Bantah success or error envelopes.",
    );
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message =
      error instanceof Error ? error.message : "Unknown network error during skill check.";

    return {
      action: config.action,
      passed: false,
      ok: false,
      responseType: "network_error",
      statusCode: null,
      durationMs,
      message,
    };
  }
}

export async function runAgentSkillCheck(endpointUrl: string): Promise<AgentSkillCheckResult> {
  const normalizedUrl = new URL(endpointUrl).toString();
  const results = await Promise.all(
    skillCheckCases.map((config) => runSkillCheckCase(normalizedUrl, config)),
  );

  const passedCount = results.filter((result) => result.passed).length;
  const complianceScore = Math.round((passedCount / skillCheckCases.length) * 100);
  const overallPassed = passedCount === skillCheckCases.length;

  return agentSkillCheckResultSchema.parse({
    endpointUrl: normalizedUrl,
    checkedAt: new Date().toISOString(),
    overallPassed,
    complianceScore,
    results,
  });
}
