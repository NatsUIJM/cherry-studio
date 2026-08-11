import type { FileProcessorId } from '@shared/data/preference/preferenceTypes'
import type {
  KnowledgeAddConflictStrategy,
  KnowledgeAddItemInput,
  KnowledgeItem,
  KnowledgePdfSplitConfirmation
} from '@shared/data/types/knowledge'

export interface PdfPageRange {
  pageStart: number
  pageEnd: number
}

export interface PdfSplitLimits {
  processorId: FileProcessorId
  maxInputBytes: number
  maxPagesPerPart?: number
  targetPagesPerPart?: number
  fingerprint: string
}

export interface PdfInspection {
  fingerprint: string
  pageCount: number
}

export interface StagedPdfPart extends PdfPageRange {
  bytes: number
  path: string
}

export interface StagedPdfSplit {
  sourcePath: string
  sourceName: string
  sourceBytes: number
  sourceFingerprint: string
  pageCount: number
  stagingDir: string
  parts: StagedPdfPart[]
  owner:
    | { kind: 'add-file'; inputIndex: number }
    | { kind: 'add-directory'; inputIndex: number }
    | { kind: 'reindex-file'; itemId: string }
    | { kind: 'reindex-directory'; itemId: string }
}

export interface PublishedPdfSplit {
  sourceRelativePath: string
  parts: Array<StagedPdfPart & { fileName: string; relativePath: string }>
}

export interface PdfSplitBundle {
  token: string
  operation: 'add' | 'reindex'
  baseId: string
  requestFingerprint: string
  limitsFingerprint: string
  expiresAt: number
  confirmation: KnowledgePdfSplitConfirmation
  splits: StagedPdfSplit[]
}

export interface PdfSplitAddRequest {
  baseId: string
  processorId: FileProcessorId
  inputs: KnowledgeAddItemInput[]
  conflictStrategy: KnowledgeAddConflictStrategy
}

export interface PdfSplitReindexRequest {
  baseId: string
  processorId: FileProcessorId
  rootItems: KnowledgeItem[]
}

export type PdfSplitWorkerInput =
  | { operation: 'inspect'; sourcePath: string }
  | {
      operation: 'split'
      sourcePath: string
      stagingDir: string
      expectedFingerprint: string
      initialRanges: PdfPageRange[]
      maxInputBytes: number
      maxParts: number
    }

export type PdfSplitWorkerMessage =
  | { type: 'inspected'; inspection: PdfInspection }
  | { type: 'split'; parts: StagedPdfPart[] }
  | { type: 'error'; code: string; message: string }
