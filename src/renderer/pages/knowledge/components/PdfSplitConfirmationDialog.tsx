import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@cherrystudio/ui'
import { getFileProcessorLabelKey } from '@renderer/i18n/label'
import { formatFileSize } from '@renderer/utils/file'
import type { KnowledgePdfSplitConfirmation } from '@shared/data/types/knowledge'
import { useTranslation } from 'react-i18next'

interface PdfSplitConfirmationDialogProps {
  confirmation: KnowledgePdfSplitConfirmation | null
  errorMessage?: string
  isConfirming: boolean
  onCancel: () => void
  onConfirm: () => void
}

const PdfSplitConfirmationDialog = ({
  confirmation,
  errorMessage,
  isConfirming,
  onCancel,
  onConfirm
}: PdfSplitConfirmationDialogProps) => {
  const { t } = useTranslation()

  if (!confirmation) return null

  const processorName = t(getFileProcessorLabelKey(confirmation.processorId))

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isConfirming) onCancel()
      }}>
      <DialogContent showCloseButton={false} size="lg" className="flex max-h-[76vh] flex-col overflow-hidden">
        <DialogHeader className="text-left">
          <DialogTitle>{t('knowledge.data_source.pdf_split.title')}</DialogTitle>
          <DialogDescription>
            {t('knowledge.data_source.pdf_split.description', { processor: processorName })}
          </DialogDescription>
        </DialogHeader>

        <ul className="min-h-0 space-y-2 overflow-y-auto pr-1">
          {confirmation.files.map((file, index) => (
            <li key={`${file.sourceName}-${index}`} className="border-border border-b pb-2 last:border-b-0">
              <div className="truncate font-medium text-sm" title={file.sourceName}>
                {file.sourceName}
              </div>
              <div className="mt-0.5 text-foreground-tertiary text-xs">
                {t('knowledge.data_source.pdf_split.file_summary', {
                  pages: file.pageCount,
                  size: formatFileSize(file.sourceBytes),
                  parts: file.parts.length
                })}
              </div>
            </li>
          ))}
        </ul>

        {errorMessage ? (
          <p role="alert" className="shrink-0 text-destructive text-sm">
            {errorMessage}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isConfirming}>
            {t('common.cancel')}
          </Button>
          <Button variant="emphasis" onClick={onConfirm} loading={isConfirming} disabled={isConfirming}>
            {t('knowledge.data_source.pdf_split.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default PdfSplitConfirmationDialog
