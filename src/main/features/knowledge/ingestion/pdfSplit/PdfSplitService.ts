import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { application } from '@application'
import { loggerService } from '@logger'
import { getFileProcessorConfigById } from '@main/features/fileProcessing'
import type { FileProcessorId } from '@shared/data/preference/preferenceTypes'
import type { DocumentToMarkdownCapability } from '@shared/data/presets/fileProcessing'
import {
  KNOWLEDGE_PDF_SPLIT_PARTS_MAX,
  type KnowledgeAddItemInput,
  type KnowledgeItem,
  type KnowledgePdfSplitConfirmation,
  KnowledgeRelativePathSchema
} from '@shared/data/types/knowledge'
import type { PosixRelativeFilePath } from '@shared/utils/file'

import { copyFileIntoKnowledgeBaseAt, getKnowledgeBaseFilePath } from '../../pathStorage'
import { createInitialPdfPageRanges, formatPdfPartFileName, pdfNeedsSplitting } from './pdfSplitPlanning'
import type {
  PdfInspection,
  PdfSplitAddRequest,
  PdfSplitBundle,
  PdfSplitLimits,
  PdfSplitReindexRequest,
  PdfSplitWorkerInput,
  PdfSplitWorkerMessage,
  PublishedPdfSplit,
  StagedPdfSplit
} from './types'

const TOKEN_TTL_MS = 10 * 60 * 1000
const MAX_SOURCE_BYTES = 1024 ** 3
const RESOURCE_HEADROOM_BYTES = 512 * 1024 ** 2
const logger = loggerService.withContext('Knowledge:PdfSplitService')

interface PdfSourceCandidate {
  sourcePath: string
  sourceName: string
  owner: StagedPdfSplit['owner']
  forceSplit?: boolean
}

export interface PdfSplitServiceDependencies {
  now: () => number
  freeMemoryBytes: () => number
  freeDiskBytes: (stagingRoot: string) => Promise<number>
  runWorker: (input: PdfSplitWorkerInput, signal?: AbortSignal) => Promise<PdfSplitWorkerMessage>
}

const defaultDependencies: PdfSplitServiceDependencies = {
  now: Date.now,
  freeMemoryBytes: os.freemem,
  freeDiskBytes: async (stagingRoot) => {
    const stats = await fsp.statfs(stagingRoot)
    return Number(stats.bavail) * Number(stats.bsize)
  },
  runWorker: async (input, signal) => {
    const { runPdfSplitWorker } = await import('./pdfSplitWorkerClient')
    return await runPdfSplitWorker(input, signal)
  }
}

export class PdfSplitService {
  private readonly bundles = new Map<string, PdfSplitBundle>()
  private readonly directoryBundles = new Map<string, StagedPdfSplit[]>()

  constructor(private readonly dependencies: PdfSplitServiceDependencies = defaultDependencies) {}

  async preflightAdd(request: PdfSplitAddRequest, signal?: AbortSignal): Promise<KnowledgePdfSplitConfirmation | null> {
    const candidates = await collectAddPdfCandidates(request.inputs, signal)
    return await this.preflight(
      'add',
      request.baseId,
      request.processorId,
      hashJson({ inputs: request.inputs, conflictStrategy: request.conflictStrategy }),
      candidates,
      signal
    )
  }

  async confirmAdd(request: PdfSplitAddRequest, token: string): Promise<PdfSplitBundle> {
    return await this.confirm(
      token,
      'add',
      request.baseId,
      request.processorId,
      hashJson({ inputs: request.inputs, conflictStrategy: request.conflictStrategy })
    )
  }

  async preflightReindex(
    request: PdfSplitReindexRequest,
    signal?: AbortSignal
  ): Promise<KnowledgePdfSplitConfirmation | null> {
    const candidates = await collectReindexPdfCandidates(request.baseId, request.rootItems, signal)
    return await this.preflight(
      'reindex',
      request.baseId,
      request.processorId,
      hashJson({ itemIds: request.rootItems.map((item) => item.id).sort() }),
      candidates,
      signal
    )
  }

  async confirmReindex(request: PdfSplitReindexRequest, token: string): Promise<PdfSplitBundle> {
    return await this.confirm(
      token,
      'reindex',
      request.baseId,
      request.processorId,
      hashJson({ itemIds: request.rootItems.map((item) => item.id).sort() })
    )
  }

  async discard(token: string): Promise<void> {
    this.bundles.delete(token)
    try {
      await fsp.rm(path.join(this.getStagingRoot(), token), { recursive: true, force: true })
    } catch (error) {
      logger.warn('Failed to remove PDF split staging', {
        token,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  async bindDirectorySplits(itemId: string, splits: StagedPdfSplit[]): Promise<void> {
    if (splits.length === 0) return
    const bindingRoot = path.join(this.getStagingRoot(), 'bound', itemId)
    await fsp.rm(bindingRoot, { recursive: true, force: true })
    await fsp.mkdir(bindingRoot, { recursive: true })
    const boundSplits: StagedPdfSplit[] = []
    try {
      for (const [index, split] of splits.entries()) {
        const destination = path.join(bindingRoot, String(index))
        await fsp.rename(split.stagingDir, destination)
        boundSplits.push({
          ...split,
          stagingDir: destination,
          parts: split.parts.map((part) => ({ ...part, path: path.join(destination, path.basename(part.path)) }))
        })
      }
      this.directoryBundles.set(itemId, boundSplits)
    } catch (error) {
      await fsp.rm(bindingRoot, { recursive: true, force: true })
      throw error
    }
  }

  async publishStagedSplit(
    baseId: string,
    split: StagedPdfSplit,
    relativePrefix: PosixRelativeFilePath,
    options: {
      signal?: AbortSignal
      sourceAlreadyStoredRelativePath?: PosixRelativeFilePath
      overwrite?: boolean
    } = {}
  ): Promise<PublishedPdfSplit> {
    const sourceFileName = path.basename(split.sourcePath)
    const sourceRelativePath =
      options.sourceAlreadyStoredRelativePath ??
      KnowledgeRelativePathSchema.parse(`${relativePrefix}/.source/${sourceFileName}`)
    const parts = split.parts.map((part) => {
      const fileName = formatPdfPartFileName(sourceFileName, part.pageStart, part.pageEnd, split.pageCount)
      return { ...part, fileName, relativePath: KnowledgeRelativePathSchema.parse(`${relativePrefix}/${fileName}`) }
    })

    if (options.sourceAlreadyStoredRelativePath) {
      const copiedRelativePaths: string[] = []
      try {
        for (const part of parts) {
          options.signal?.throwIfAborted()
          await copyStagedFile(baseId, part.path, part.relativePath, options.signal, options.overwrite ?? true)
          copiedRelativePaths.push(part.relativePath)
        }
      } catch (error) {
        await Promise.all(
          copiedRelativePaths.map((relativePath) =>
            fsp.rm(getKnowledgeBaseFilePath(baseId, relativePath), { force: true }).catch(() => undefined)
          )
        )
        throw error
      }
      return { sourceRelativePath, parts }
    }

    const stagedRelativePrefix = KnowledgeRelativePathSchema.parse(`${relativePrefix}.staged-${randomUUID()}`)
    const stagedAbsolutePath = getKnowledgeBaseFilePath(baseId, stagedRelativePrefix)
    const finalAbsolutePath = getKnowledgeBaseFilePath(baseId, relativePrefix)
    try {
      await copyStagedFile(
        baseId,
        split.sourcePath,
        KnowledgeRelativePathSchema.parse(`${stagedRelativePrefix}/.source/${sourceFileName}`),
        options.signal,
        true
      )
      for (const part of parts) {
        options.signal?.throwIfAborted()
        await copyStagedFile(
          baseId,
          part.path,
          KnowledgeRelativePathSchema.parse(`${stagedRelativePrefix}/${part.fileName}`),
          options.signal,
          true
        )
      }
      if (options.overwrite) {
        await fsp.rm(finalAbsolutePath, { recursive: true, force: true })
      }
      await fsp.rename(stagedAbsolutePath, finalAbsolutePath)
      return { sourceRelativePath, parts }
    } catch (error) {
      await fsp.rm(stagedAbsolutePath, { recursive: true, force: true })
      throw error
    }
  }

  getDirectorySplits(itemId: string): readonly StagedPdfSplit[] {
    return this.directoryBundles.get(itemId) ?? []
  }

  async discardDirectorySplits(itemId: string): Promise<void> {
    const splits = this.directoryBundles.get(itemId)
    this.directoryBundles.delete(itemId)
    if (splits?.[0]) {
      await fsp.rm(path.dirname(splits[0].stagingDir), { recursive: true, force: true })
    }
  }

  async cleanupExpired(): Promise<void> {
    const now = this.dependencies.now()
    const expiredTokens = [...this.bundles.values()]
      .filter((bundle) => bundle.expiresAt <= now)
      .map((bundle) => bundle.token)
    await Promise.all(expiredTokens.map((token) => this.discard(token)))
  }

  async cleanupAll(): Promise<void> {
    this.bundles.clear()
    this.directoryBundles.clear()
    await fsp.rm(this.getStagingRoot(), { recursive: true, force: true })
    await fsp.mkdir(this.getStagingRoot(), { recursive: true })
  }

  private async preflight(
    operation: PdfSplitBundle['operation'],
    baseId: string,
    processorId: FileProcessorId,
    requestFingerprint: string,
    candidates: PdfSourceCandidate[],
    signal?: AbortSignal
  ): Promise<KnowledgePdfSplitConfirmation | null> {
    await this.cleanupExpired()
    if (candidates.length === 0) return null

    const limits = resolvePdfSplitLimits(processorId)
    const inspected: Array<PdfSourceCandidate & PdfInspection & { sourceBytes: number }> = []
    for (const candidate of candidates) {
      signal?.throwIfAborted()
      const stats = await fsp.stat(candidate.sourcePath)
      if (!stats.isFile()) {
        throw new Error(`PDF source is not a file: ${candidate.sourceName}`)
      }
      if (stats.size <= 0) {
        throw new Error(`PDF is empty: ${candidate.sourceName}`)
      }
      if (stats.size >= MAX_SOURCE_BYTES) {
        throw new Error(`PDF must be smaller than 1 GB: ${candidate.sourceName}`)
      }
      const inspectionMessage = await this.dependencies.runWorker(
        { operation: 'inspect', sourcePath: candidate.sourcePath },
        signal
      )
      if (inspectionMessage.type === 'error') {
        throw toPdfSplitError(candidate.sourceName, inspectionMessage)
      }
      if (inspectionMessage.type !== 'inspected') {
        throw new Error(`Invalid PDF inspection result: ${candidate.sourceName}`)
      }
      inspected.push({ ...candidate, ...inspectionMessage.inspection, sourceBytes: stats.size })
    }

    const splitCandidates = inspected.filter(
      (candidate) => candidate.forceSplit || pdfNeedsSplitting(candidate.pageCount, candidate.sourceBytes, limits)
    )
    if (splitCandidates.length === 0) return null

    await this.assertResources(splitCandidates.map((candidate) => candidate.sourceBytes))
    const token = randomUUID()
    const tokenRoot = path.join(this.getStagingRoot(), token)
    await fsp.mkdir(tokenRoot, { recursive: true })

    const splits: StagedPdfSplit[] = []
    try {
      for (const [index, candidate] of splitCandidates.entries()) {
        signal?.throwIfAborted()
        const stagingDir = path.join(tokenRoot, String(index))
        await fsp.mkdir(stagingDir, { recursive: true })
        const splitMessage = await this.dependencies.runWorker(
          {
            operation: 'split',
            sourcePath: candidate.sourcePath,
            stagingDir,
            expectedFingerprint: candidate.fingerprint,
            initialRanges: createInitialPdfPageRanges(candidate.pageCount, limits),
            maxInputBytes: limits.maxInputBytes,
            maxParts: KNOWLEDGE_PDF_SPLIT_PARTS_MAX
          },
          signal
        )
        if (splitMessage.type === 'error') {
          throw toPdfSplitError(candidate.sourceName, splitMessage)
        }
        if (splitMessage.type !== 'split') {
          throw new Error(`Invalid PDF split result: ${candidate.sourceName}`)
        }
        splits.push({
          sourcePath: candidate.sourcePath,
          sourceName: candidate.sourceName,
          sourceBytes: candidate.sourceBytes,
          sourceFingerprint: candidate.fingerprint,
          pageCount: candidate.pageCount,
          stagingDir,
          parts: splitMessage.parts,
          owner: candidate.owner
        })
      }

      const totalTasks = splits.reduce((total, split) => total + split.parts.length, 0)
      if (totalTasks > KNOWLEDGE_PDF_SPLIT_PARTS_MAX) {
        throw new Error(
          `This operation would create ${totalTasks} PDF parts; the maximum is ${KNOWLEDGE_PDF_SPLIT_PARTS_MAX}`
        )
      }
      const expiresAt = this.dependencies.now() + TOKEN_TTL_MS
      const confirmation: KnowledgePdfSplitConfirmation = {
        token,
        expiresAt: new Date(expiresAt).toISOString(),
        processorId,
        files: splits.map((split) => ({
          sourceName: split.sourceName,
          pageCount: split.pageCount,
          sourceBytes: split.sourceBytes,
          parts: split.parts.map(({ pageStart, pageEnd, bytes }) => ({ pageStart, pageEnd, bytes }))
        })),
        totalTasks,
        estimatedDiskBytes: 3 * splits.reduce((total, split) => total + split.sourceBytes, 0) + RESOURCE_HEADROOM_BYTES
      }
      const bundle: PdfSplitBundle = {
        token,
        operation,
        baseId,
        requestFingerprint,
        limitsFingerprint: limits.fingerprint,
        expiresAt,
        confirmation,
        splits
      }
      this.bundles.set(token, bundle)
      return confirmation
    } catch (error) {
      await fsp.rm(tokenRoot, { recursive: true, force: true })
      throw error
    }
  }

  private async confirm(
    token: string,
    operation: PdfSplitBundle['operation'],
    baseId: string,
    processorId: FileProcessorId,
    requestFingerprint: string
  ): Promise<PdfSplitBundle> {
    const bundle = this.bundles.get(token)
    if (!bundle || bundle.expiresAt <= this.dependencies.now()) {
      if (bundle) await this.discard(token)
      throw new Error('PDF split confirmation expired; review the updated split plan and confirm again')
    }
    const limits = resolvePdfSplitLimits(processorId)
    if (
      bundle.operation !== operation ||
      bundle.baseId !== baseId ||
      bundle.requestFingerprint !== requestFingerprint ||
      bundle.limitsFingerprint !== limits.fingerprint
    ) {
      await this.discard(token)
      throw new Error('PDF split confirmation is no longer valid; review the updated split plan and confirm again')
    }

    for (const split of bundle.splits) {
      const fingerprint = await hashFile(split.sourcePath)
      if (fingerprint !== split.sourceFingerprint) {
        await this.discard(token)
        throw new Error(`PDF changed after confirmation was prepared: ${split.sourceName}`)
      }
    }
    return bundle
  }

  private async assertResources(sourceSizes: number[]): Promise<void> {
    const largestSource = Math.max(...sourceSizes)
    const requiredMemory = 4 * largestSource + RESOURCE_HEADROOM_BYTES
    const freeMemory = this.dependencies.freeMemoryBytes()
    if (freeMemory < requiredMemory) {
      throw new Error(
        `Not enough available memory to split PDF files (requires ${formatMiB(requiredMemory)}, available ${formatMiB(freeMemory)})`
      )
    }

    const requiredDisk = 3 * sourceSizes.reduce((total, size) => total + size, 0) + RESOURCE_HEADROOM_BYTES
    const freeDisk = await this.dependencies.freeDiskBytes(this.getStagingRoot())
    if (freeDisk < requiredDisk) {
      throw new Error(
        `Not enough available disk space to split PDF files (requires ${formatMiB(requiredDisk)}, available ${formatMiB(freeDisk)})`
      )
    }
  }

  private getStagingRoot(): string {
    return application.getPath('feature.knowledgebase.pdf_split.temp')
  }
}

function resolvePdfSplitLimits(processorId: FileProcessorId): PdfSplitLimits {
  const config = getFileProcessorConfigById(processorId)
  const capability = config.capabilities.find(
    (candidate): candidate is DocumentToMarkdownCapability => candidate.feature === 'document_to_markdown'
  )
  if (!capability) {
    throw new Error(`File processor ${processorId} does not support document_to_markdown`)
  }
  const fingerprint = hashJson({
    processorId,
    maxInputBytes: capability.maxInputBytes,
    maxPagesPerPart: capability.maxPagesPerPart,
    targetPagesPerPart: capability.targetPagesPerPart,
    apiHost: capability.apiHost,
    modelId: capability.modelId,
    apiKeys: config.apiKeys,
    options: config.options
  })
  return {
    processorId,
    maxInputBytes: capability.maxInputBytes,
    maxPagesPerPart: capability.maxPagesPerPart,
    targetPagesPerPart: capability.targetPagesPerPart,
    fingerprint
  }
}

async function collectAddPdfCandidates(
  inputs: KnowledgeAddItemInput[],
  signal?: AbortSignal
): Promise<PdfSourceCandidate[]> {
  const candidates: PdfSourceCandidate[] = []
  for (const [inputIndex, input] of inputs.entries()) {
    signal?.throwIfAborted()
    if (input.type === 'file' && isPdfPath(input.data.path) && !input.data.indexedPath) {
      candidates.push({
        sourcePath: input.data.path,
        sourceName: path.basename(input.data.path),
        owner: { kind: 'add-file', inputIndex }
      })
    } else if (input.type === 'directory') {
      const paths = await collectDirectoryPdfPaths(input.data.source, signal)
      candidates.push(
        ...paths.map((sourcePath) => ({
          sourcePath,
          sourceName: path.relative(input.data.source, sourcePath).replace(/\\/g, '/'),
          owner: { kind: 'add-directory' as const, inputIndex }
        }))
      )
    }
  }
  return candidates
}

async function collectReindexPdfCandidates(
  baseId: string,
  rootItems: KnowledgeItem[],
  signal?: AbortSignal
): Promise<PdfSourceCandidate[]> {
  const candidates: PdfSourceCandidate[] = []
  for (const item of rootItems) {
    signal?.throwIfAborted()
    if (item.type === 'file' && isPdfPath(item.data.relativePath) && !item.data.pdfPart) {
      candidates.push({
        sourcePath: getKnowledgeBaseFilePath(baseId, item.data.relativePath),
        sourceName: path.basename(item.data.relativePath),
        owner: { kind: 'reindex-file', itemId: item.id }
      })
    } else if (item.type === 'directory' && item.data.pdfSplitSource) {
      candidates.push({
        sourcePath: getKnowledgeBaseFilePath(baseId, item.data.pdfSplitSource.relativePath),
        sourceName: item.data.pdfSplitSource.sourceName,
        owner: { kind: 'reindex-directory', itemId: item.id },
        forceSplit: true
      })
    } else if (item.type === 'directory') {
      const paths = await collectDirectoryPdfPaths(item.data.source, signal)
      candidates.push(
        ...paths.map((sourcePath) => ({
          sourcePath,
          sourceName: path.relative(item.data.source, sourcePath).replace(/\\/g, '/'),
          owner: { kind: 'reindex-directory' as const, itemId: item.id }
        }))
      )
    }
  }
  return candidates
}

async function collectDirectoryPdfPaths(directoryPath: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted()
  const entries = await fsp.readdir(directoryPath, { withFileTypes: true })
  const paths: string[] = []
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (entry.name.startsWith('.')) continue
    const entryPath = path.join(directoryPath, entry.name)
    if (entry.isDirectory()) {
      paths.push(...(await collectDirectoryPdfPaths(entryPath, signal)))
    } else if (entry.isFile() && isPdfPath(entry.name)) {
      paths.push(entryPath)
    }
  }
  return paths
}

function isPdfPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.pdf'
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return hash.digest('hex')
}

async function copyStagedFile(
  baseId: string,
  sourcePath: string,
  relativePath: PosixRelativeFilePath,
  signal: AbortSignal | undefined,
  overwrite: boolean
): Promise<void> {
  await copyFileIntoKnowledgeBaseAt(baseId, sourcePath, relativePath, { signal, overwrite })
}

function formatMiB(bytes: number): string {
  return `${Math.ceil(bytes / 1024 ** 2)} MB`
}

function toPdfSplitError(sourceName: string, message: Extract<PdfSplitWorkerMessage, { type: 'error' }>): Error {
  switch (message.code) {
    case 'encrypted':
      return new Error(`PDF is encrypted. Remove the password and try again: ${sourceName}`)
    case 'empty':
      return new Error(`PDF contains no pages: ${sourceName}`)
    case 'invalid':
      return new Error(`PDF is damaged or invalid: ${sourceName}`)
    case 'single_page_too_large':
      return new Error(`A single PDF page exceeds the processor size limit: ${sourceName}`)
    case 'too_many_parts':
      return new Error(`PDF requires more than ${KNOWLEDGE_PDF_SPLIT_PARTS_MAX} parts: ${sourceName}`)
    case 'source_changed':
      return new Error(`PDF changed while it was being prepared: ${sourceName}`)
    default:
      return new Error(`Failed to prepare PDF ${sourceName}: ${message.message}`)
  }
}

export const pdfSplitService = new PdfSplitService()
