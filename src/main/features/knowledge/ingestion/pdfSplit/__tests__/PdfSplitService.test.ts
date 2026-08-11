import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { AbsoluteFilePath } from '@shared/types/file'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({ stagingRoot: '' }))

vi.mock('@application', () => ({
  application: {
    getPath: () => testState.stagingRoot
  }
}))

vi.mock('@main/features/fileProcessing', () => ({
  getFileProcessorConfigById: (processorId: string) => ({
    id: processorId,
    type: 'api',
    capabilities: [
      {
        feature: 'document_to_markdown',
        inputs: ['document'],
        output: 'markdown',
        maxInputBytes: 1024 * 1024,
        targetPagesPerPart: 30
      }
    ]
  })
}))

import { PdfSplitService, type PdfSplitServiceDependencies } from '../PdfSplitService'
import type { PdfSplitWorkerInput, PdfSplitWorkerMessage, StagedPdfPart } from '../types'

describe('PdfSplitService', () => {
  let tempDir: string
  let sourcePath: string
  let now: number

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-pdf-service-'))
    testState.stagingRoot = path.join(tempDir, 'staging')
    await fs.mkdir(testState.stagingRoot, { recursive: true })
    sourcePath = path.join(tempDir, 'source.pdf')
    await fs.writeFile(sourcePath, 'source bytes')
    now = Date.parse('2026-08-10T08:00:00.000Z')
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('returns a confirmation without publishing knowledge items and validates the token', async () => {
    const runWorker = createWorkerMock({ pageCount: 31, partCount: 2 })
    const service = createService(runWorker)
    const request = createAddRequest()

    const confirmation = await service.preflightAdd(request)

    expect(confirmation).toMatchObject({ processorId: 'doc2x', totalTasks: 2 })
    expect(confirmation?.files[0].parts).toEqual([
      { pageStart: 1, pageEnd: 1, bytes: 100 },
      { pageStart: 2, pageEnd: 2, bytes: 100 }
    ])
    await expect(service.confirmAdd(request, confirmation!.token)).resolves.toMatchObject({ operation: 'add' })
  })

  it('invalidates confirmation when the source changes', async () => {
    const service = createService(createWorkerMock({ pageCount: 31, partCount: 2 }))
    const request = createAddRequest()
    const confirmation = await service.preflightAdd(request)
    await fs.writeFile(sourcePath, 'changed source bytes')

    await expect(service.confirmAdd(request, confirmation!.token)).rejects.toThrow('changed after confirmation')
  })

  it('expires tokens and removes their staged output', async () => {
    const service = createService(createWorkerMock({ pageCount: 31, partCount: 2 }))
    const request = createAddRequest()
    const confirmation = await service.preflightAdd(request)
    now += 11 * 60 * 1000

    await expect(service.confirmAdd(request, confirmation!.token)).rejects.toThrow('expired')
    await expect(fs.readdir(testState.stagingRoot)).resolves.toEqual([])
  })

  it('rejects aggregate plans over 200 parts and cleans staging', async () => {
    const secondSource = path.join(tempDir, 'second.pdf')
    await fs.writeFile(secondSource, 'second source')
    const service = createService(createWorkerMock({ pageCount: 3030, partCount: 101 }))
    const request = {
      ...createAddRequest(),
      inputs: [
        { type: 'file' as const, data: { source: 'source.pdf', path: sourcePath as AbsoluteFilePath } },
        { type: 'file' as const, data: { source: 'second.pdf', path: secondSource as AbsoluteFilePath } }
      ]
    }

    await expect(service.preflightAdd(request)).rejects.toThrow('maximum is 200')
    await expect(fs.readdir(testState.stagingRoot)).resolves.toEqual([])
  })

  it('discovers nested PDFs in a folder and binds every split to that folder input', async () => {
    const folder = path.join(tempDir, 'folder')
    const nested = path.join(folder, 'nested')
    await fs.mkdir(nested, { recursive: true })
    await fs.writeFile(path.join(folder, 'root.pdf'), 'root pdf')
    await fs.writeFile(path.join(nested, 'child.PDF'), 'child pdf')
    await fs.writeFile(path.join(nested, 'ignore.txt'), 'ignore')
    const service = createService(createWorkerMock({ pageCount: 31, partCount: 2 }))
    const request = {
      baseId: 'base-1',
      processorId: 'doc2x' as const,
      conflictStrategy: 'detect' as const,
      inputs: [{ type: 'directory' as const, data: { source: folder } }]
    }

    const confirmation = await service.preflightAdd(request)
    const bundle = await service.confirmAdd(request, confirmation!.token)

    expect(confirmation?.files.map((file) => file.sourceName).sort()).toEqual(['nested/child.PDF', 'root.pdf'])
    expect(bundle.splits).toHaveLength(2)
    expect(bundle.splits.every((split) => split.owner.kind === 'add-directory' && split.owner.inputIndex === 0)).toBe(
      true
    )
  })

  it('surfaces encrypted PDF errors before staging remote tasks', async () => {
    const service = createService(
      vi.fn(async () => ({ type: 'error', code: 'encrypted', message: 'encrypted' }) as PdfSplitWorkerMessage)
    )

    await expect(service.preflightAdd(createAddRequest())).rejects.toThrow('Remove the password')
  })

  it('checks memory and disk headroom before generating parts', async () => {
    const runWorker = createWorkerMock({ pageCount: 31, partCount: 2 })
    const service = createService(runWorker, { freeMemoryBytes: () => 1 })

    await expect(service.preflightAdd(createAddRequest())).rejects.toThrow('available memory')
    expect(runWorker).toHaveBeenCalledTimes(1)
  })

  it('cleans staging when splitting aborts or fails', async () => {
    const runWorker = vi.fn(async (input: PdfSplitWorkerInput): Promise<PdfSplitWorkerMessage> => {
      if (input.operation === 'inspect') {
        return { type: 'inspected', inspection: { pageCount: 31, fingerprint: await hashFile(input.sourcePath) } }
      }
      await fs.writeFile(path.join(input.stagingDir, 'partial.pdf'), 'partial')
      throw new DOMException('cancelled', 'AbortError')
    })
    const service = createService(runWorker)

    await expect(service.preflightAdd(createAddRequest())).rejects.toThrow('cancelled')
    await expect(fs.readdir(testState.stagingRoot)).resolves.toEqual([])
  })

  function createService(
    runWorker: PdfSplitServiceDependencies['runWorker'],
    overrides: Partial<PdfSplitServiceDependencies> = {}
  ): PdfSplitService {
    return new PdfSplitService({
      now: () => now,
      freeMemoryBytes: () => Number.MAX_SAFE_INTEGER,
      freeDiskBytes: async () => Number.MAX_SAFE_INTEGER,
      runWorker,
      ...overrides
    })
  }

  function createAddRequest() {
    return {
      baseId: 'base-1',
      processorId: 'doc2x' as const,
      conflictStrategy: 'detect' as const,
      inputs: [{ type: 'file' as const, data: { source: 'source.pdf', path: sourcePath as AbsoluteFilePath } }]
    }
  }
})

function createWorkerMock(options: { pageCount: number; partCount: number }) {
  return vi.fn(async (input: PdfSplitWorkerInput): Promise<PdfSplitWorkerMessage> => {
    if (input.operation === 'inspect') {
      return {
        type: 'inspected',
        inspection: { pageCount: options.pageCount, fingerprint: await hashFile(input.sourcePath) }
      }
    }
    const parts: StagedPdfPart[] = []
    for (let index = 0; index < options.partCount; index += 1) {
      const partPath = path.join(input.stagingDir, `part-${index}.pdf`)
      await fs.writeFile(partPath, `part ${index}`)
      parts.push({ pageStart: index + 1, pageEnd: index + 1, bytes: 100, path: partPath })
    }
    return { type: 'split', parts }
  })
}

async function hashFile(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(filePath))
    .digest('hex')
}
