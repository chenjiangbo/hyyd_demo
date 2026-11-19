export const PINGAN_ORDER_TYPES = [
  { code: 'ORDINARY_REGISTER', name: 'VIP 挂号' },
  { code: 'HOSPITALIZE_DOMESTIC', name: '国内住院' },
] as const;

export const PINGAN_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const PINGAN_INSTALL_DATE_KEY = 'pinganCollectionStartDate';
export const PINGAN_STATUS_KEY = 'pinganCollectionStatus';

export type PinganOrderType = (typeof PINGAN_ORDER_TYPES)[number]['code'];

export type PinganOrder = {
  pinganUserId: string;
  orderId: string;
  orderType: PinganOrderType;
  orderTypeStr: string;
  status: string;
  statusStr: string;
  handlerUserId?: string | null;
  handlerName?: string | null;
  listJson: Record<string, unknown>;
  detailJson?: Record<string, unknown>;
  decryptedFields: Record<string, string>;
  listFingerprint: string;
  detailFingerprint?: string;
  attachmentKeys: string[];
  captureState: 'list' | 'detail' | 'complete' | 'partial_failure';
  attachmentState?: 'not_captured' | 'complete' | 'partial_failure';
  attachmentErrors?: string[];
  errors: string[];
  backendSyncedAt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type PinganAttachment = {
  pinganUserId: string;
  id: string;
  orderId: string;
  fileName: string;
  fileType: string | null;
  mimeType: string;
  size: number;
  sha256: string;
  blob: Blob;
  capturedAt: string;
};

export type PinganEvent = {
  id: string;
  runId: string;
  at: string;
  level: 'info' | 'error';
  kind: string;
  orderId?: string;
  orderType?: string;
  pageNum?: number;
  method?: string;
  httpStatus?: number;
  businessCode?: string | number;
  durationMs?: number;
  message?: string;
};

export type PinganRunStatus = {
  state: 'waiting_login' | 'waiting_page' | 'running' | 'completed' | 'partial_failure' | 'error';
  installDate: string;
  scanStartDate?: string;
  scanEndDate?: string;
  startedAt?: string;
  updatedAt: string;
  runId?: string;
  currentType?: string;
  currentPage?: number;
  pageCount?: number;
  listCount: number;
  detailCount: number;
  decryptedFieldCount: number;
  attachmentCount: number;
  errorCount: number;
  lastError?: string;
  backendAccountState?: 'registered' | 'offline';
};

export type PinganIdentity = { pinganUserId: string; displayName: string };

export type PinganProbeMessage = {
  source: 'HYYD_PINGAN_PROBE';
  payload:
    | {
        kind: 'api-result';
        requestId: string;
        at: string;
        method: string;
        requestParam: Record<string, unknown>;
        response?: unknown;
        httpStatus?: number;
        durationMs: number;
        error?: string;
      }
    | {
        kind: 'api-response';
        at: string;
        href: string;
        method: string;
        requestParam: Record<string, unknown>;
        response: unknown;
        httpStatus: number;
        durationMs: number;
      };
};

export type PinganApiProbeEvent = Extract<PinganProbeMessage['payload'], { kind: 'api-response' }>;
export type PinganApiResultMessage = Extract<PinganProbeMessage['payload'], { kind: 'api-result' }>;

export type PinganApiRequestMessage = {
  source: 'HYYD_PINGAN_API_REQUEST';
  requestId: string;
  method: string;
  params: Record<string, unknown>;
};
