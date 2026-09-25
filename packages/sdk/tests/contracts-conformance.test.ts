/**
 * SDK <-> @fishmem/contracts conformance.
 *
 * The published SDK keeps zero runtime dependencies, so its wire types are
 * hand-written. This file pins them to the Zod contracts the server actually
 * parses and emits. It is enforced by `pnpm --filter @fishmem/sdk typecheck`
 * (tsc includes tests/); a drift is a compile error naming the pair.
 *
 * Rules:
 * - Requests: every SDK request must be accepted by the contract's input type,
 *   and the SDK and contract must expose the same field names (a missing SDK
 *   field is an unreachable server feature; an extra SDK field is silently
 *   stripped by the server).
 * - Responses: the SDK type and the contract's output type must be mutually
 *   assignable.
 */
import type * as contracts from "@fishmem/contracts";
import { describe, expect, it } from "vitest";
import type * as sdk from "../src/types";

// Zod 4 carries its inferred types on `_zod`; reading them directly keeps
// zod itself out of the SDK's dependency graph.
type Input<S extends { _zod: { input: unknown } }> = S["_zod"]["input"];
type Output<S extends { _zod: { output: unknown } }> = S["_zod"]["output"];

type Assignable<A, B> = [A] extends [B] ? true : false;
type KeyDrift<A, B> =
	| Exclude<keyof A, keyof B>
	| Exclude<keyof B, keyof A>;

/** Compiles only when `Result` is exactly `true`; the tuple names the pair. */
function conforms<Result extends true>(_pair: string): Result {
	return true as Result;
}

type RequestConforms<SdkType, Schema extends { _zod: { input: unknown } }> =
	Assignable<SdkType, Input<Schema>> extends true
		? [KeyDrift<SdkType, Input<Schema>>] extends [never]
			? true
			: { keyDrift: KeyDrift<SdkType, Input<Schema>> }
		: { notAccepted: SdkType; contract: Input<Schema> };

type ResponseConforms<SdkType, Schema extends { _zod: { output: unknown } }> =
	Assignable<SdkType, Output<Schema>> extends true
		? Assignable<Output<Schema>, SdkType> extends true
			? true
			: { contractNotAssignableToSdk: Output<Schema> }
		: { sdkNotAssignableToContract: SdkType };

type Pairs = {
	// ── shared shapes ────────────────────────────────────────────────────────
	scope: ResponseConforms<sdk.MemoryScope, typeof contracts.ScopeSchema>;
	message: ResponseConforms<sdk.MemoryMessage, typeof contracts.MessageSchema>;
	memoryType: ResponseConforms<
		sdk.MemoryType,
		typeof contracts.MemoryTypeSchema
	>;
	searchMode: ResponseConforms<
		sdk.SearchMode,
		typeof contracts.SearchModeSchema
	>;
	searchStrategy: ResponseConforms<
		sdk.SearchStrategy,
		typeof contracts.SearchStrategySchema
	>;
	searchSort: ResponseConforms<
		sdk.SearchSort,
		typeof contracts.SearchSortSchema
	>;
	applicabilityKind: ResponseConforms<
		sdk.ApplicabilityKind,
		typeof contracts.ApplicabilityKindSchema
	>;
	applicability: ResponseConforms<
		sdk.ApplicabilityContext,
		typeof contracts.ApplicabilityContextSchema
	>;
	// The SDK type is deliberately stricter (operator-correlated values); the
	// contract checks that correlation at runtime. Request direction only.
	filterExpression: Assignable<
		sdk.MemoryFilterExpression,
		Input<typeof contracts.MemoryFilterExpressionSchema>
	>;
	scopeEntityType: ResponseConforms<
		sdk.ScopeEntityType,
		typeof contracts.ScopeEntityTypeSchema
	>;

	// ── memory requests ──────────────────────────────────────────────────────
	addRequest: RequestConforms<
		sdk.AddMemoryInput,
		typeof contracts.AddMemoryCommandSchema
	>;
	searchRequest: RequestConforms<
		sdk.SearchMemoriesInput,
		typeof contracts.SearchMemoryCommandSchema
	>;
	updateRequest: RequestConforms<
		sdk.UpdateMemoryInput,
		typeof contracts.UpdateMemoryCommandSchema
	>;
	feedbackRequest: RequestConforms<
		sdk.SetMemoryFeedbackInput,
		typeof contracts.SetMemoryFeedbackCommandSchema
	>;
	batchUpdateRequest: RequestConforms<
		sdk.BatchUpdateMemoriesInput,
		typeof contracts.BatchUpdateMemoriesCommandSchema
	>;
	batchDeleteRequest: RequestConforms<
		sdk.BatchDeleteMemoriesInput,
		typeof contracts.BatchDeleteMemoriesCommandSchema
	>;
	eventListRequest: RequestConforms<
		sdk.ListMemoryEventsInput,
		typeof contracts.MemoryEventListQuerySchema
	>;
	scopeEntityListRequest: RequestConforms<
		sdk.ListScopeEntitiesInput,
		typeof contracts.ListScopeEntitiesQuerySchema
	>;
	importRequest: RequestConforms<
		sdk.ImportMemoriesInput,
		typeof contracts.ImportMemoryCommandSchema
	>;

	// ── memory responses ─────────────────────────────────────────────────────
	memory: ResponseConforms<sdk.Memory, typeof contracts.MemorySchema>;
	memoryPage: ResponseConforms<sdk.MemoryPage, typeof contracts.MemoryPageSchema>;
	addResult: ResponseConforms<
		sdk.AddMemoryResult,
		typeof contracts.AddResultSchema
	>;
	addResponse: ResponseConforms<
		sdk.AddMemoriesResult,
		typeof contracts.AddMemoryResponseSchema
	>;
	asyncReceipt: ResponseConforms<
		sdk.AsyncMemoryReceipt,
		typeof contracts.AsyncMemoryReceiptSchema
	>;
	eventStatus: ResponseConforms<
		sdk.MemoryEventStatus,
		typeof contracts.MemoryEventStatusSchema
	>;
	writeSummary: ResponseConforms<
		sdk.MemoryWriteSummary,
		typeof contracts.MemoryWriteSummarySchema
	>;
	event: ResponseConforms<sdk.MemoryEvent, typeof contracts.MemoryEventSchema>;
	eventPage: ResponseConforms<
		sdk.MemoryEventPage,
		typeof contracts.MemoryEventPageSchema
	>;
	deleteMemory: ResponseConforms<
		sdk.DeleteMemoryResult,
		typeof contracts.DeleteMemoryResponseSchema
	>;
	deleteMemories: ResponseConforms<
		sdk.DeleteMemoriesResult,
		typeof contracts.DeleteMemoriesResponseSchema
	>;
	scopeEntity: ResponseConforms<
		sdk.ScopeEntity,
		typeof contracts.ScopeEntitySchema
	>;
	scopeEntityPage: ResponseConforms<
		sdk.ScopeEntityPage,
		typeof contracts.ScopeEntityPageSchema
	>;
	deleteScopeEntity: ResponseConforms<
		sdk.DeleteScopeEntityResult,
		typeof contracts.DeleteScopeEntityResponseSchema
	>;
	beliefEntry: ResponseConforms<
		sdk.BeliefEntry,
		typeof contracts.BeliefEntrySchema
	>;
	beliefChain: ResponseConforms<
		sdk.BeliefChain,
		typeof contracts.BeliefChainSchema
	>;
	searchTrace: ResponseConforms<
		sdk.SearchTrace,
		typeof contracts.SearchTraceSchema
	>;
	searchResponse: ResponseConforms<
		sdk.SearchMemoriesResult,
		typeof contracts.SearchMemoryResponseSchema
	>;
	historyEntry: ResponseConforms<
		sdk.MemoryHistoryEntry,
		typeof contracts.MemoryHistoryEntrySchema
	>;
	feedback: ResponseConforms<
		sdk.MemoryFeedback,
		typeof contracts.MemoryFeedbackSchema
	>;
	feedbackResponse: ResponseConforms<
		sdk.MemoryFeedbackResponse,
		typeof contracts.MemoryFeedbackResponseSchema
	>;
	clearFeedbackResponse: ResponseConforms<
		sdk.ClearMemoryFeedbackResponse,
		typeof contracts.ClearMemoryFeedbackResponseSchema
	>;
	operation: ResponseConforms<
		sdk.MemoryOperation,
		typeof contracts.OperationSchema
	>;
	health: ResponseConforms<
		sdk.HealthStatus,
		typeof contracts.HealthResponseSchema
	>;

	// ── documents ────────────────────────────────────────────────────────────
	ingestRequest: RequestConforms<
		sdk.IngestDocumentInput,
		typeof contracts.IngestDocumentCommandSchema
	>;
	createUploadRequest: RequestConforms<
		sdk.CreateDocumentUploadInput,
		typeof contracts.CreateDocumentUploadCommandSchema
	>;
	searchDocumentsRequest: RequestConforms<
		sdk.SearchDocumentsInput,
		typeof contracts.SearchDocumentCommandSchema
	>;
	listDocumentsRequest: RequestConforms<
		sdk.ListDocumentsInput,
		typeof contracts.ListDocumentQuerySchema
	>;
	sourceAsset: ResponseConforms<
		sdk.SourceAsset,
		typeof contracts.SourceAssetSchema
	>;
	createUploadResponse: ResponseConforms<
		sdk.CreateDocumentUploadResult,
		typeof contracts.CreateDocumentUploadResponseSchema
	>;
	completeUploadResponse: ResponseConforms<
		sdk.CompleteDocumentUploadResult,
		typeof contracts.CompleteDocumentUploadResponseSchema
	>;
	document: ResponseConforms<sdk.Document, typeof contracts.DocumentSchema>;
	documentContent: ResponseConforms<
		sdk.DocumentContent,
		typeof contracts.DocumentContentSchema
	>;
	documentChunk: ResponseConforms<
		sdk.DocumentChunk,
		typeof contracts.DocumentChunkSchema
	>;
	documentSearchHit: ResponseConforms<
		sdk.DocumentSearchHit,
		typeof contracts.DocumentSearchHitSchema
	>;
	ingestResponse: ResponseConforms<
		sdk.IngestDocumentResult,
		typeof contracts.IngestDocumentResponseSchema
	>;
	documentPage: ResponseConforms<
		sdk.DocumentPage,
		typeof contracts.DocumentPageSchema
	>;
	searchDocumentsResponse: ResponseConforms<
		sdk.SearchDocumentsResult,
		typeof contracts.SearchDocumentResponseSchema
	>;
	deleteDocument: ResponseConforms<
		sdk.DeleteDocumentResult,
		typeof contracts.DeleteDocumentResponseSchema
	>;

	// ── state / beliefs / profile ────────────────────────────────────────────
	stateRequest: RequestConforms<
		sdk.StateQuery,
		typeof contracts.StateQuerySchema
	>;
	beliefRequest: RequestConforms<
		sdk.BeliefQuery,
		typeof contracts.BeliefQuerySchema
	>;
	profileRequest: RequestConforms<
		sdk.ProfileQuery,
		typeof contracts.ProfileQuerySchema
	>;
	stateSlot: ResponseConforms<sdk.StateSlot, typeof contracts.StateSlotSchema>;
	beliefViewMode: ResponseConforms<
		sdk.BeliefViewMode,
		typeof contracts.BeliefViewModeSchema
	>;
	beliefEvidence: ResponseConforms<
		sdk.BeliefEvidence,
		typeof contracts.BeliefEvidenceSchema
	>;
	beliefCandidate: ResponseConforms<
		sdk.BeliefCandidate,
		typeof contracts.BeliefCandidateSchema
	>;
	beliefView: ResponseConforms<sdk.BeliefView, typeof contracts.BeliefViewSchema>;
	profileSection: ResponseConforms<
		sdk.ProfileSection,
		typeof contracts.ProfileSectionSchema
	>;
};

/** Every pair must resolve to `true`; a drift reports the offending key. */
type AllConform = {
	[K in keyof Pairs]: Pairs[K] extends true ? true : { drift: K; detail: Pairs[K] };
};
type Failures = {
	[K in keyof AllConform]: AllConform[K] extends true ? never : AllConform[K];
}[keyof AllConform];

describe("SDK wire types conform to @fishmem/contracts", () => {
	it("has no request or response drift (enforced by tsc)", () => {
		expect(
			conforms<[Failures] extends [never] ? true : Failures>("all pairs"),
		).toBe(true);
	});
});
