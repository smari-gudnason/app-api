import { Transport, TransportRequestOptions, TransportRequestOptionsWithMeta, TransportRequestOptionsWithOutMeta, TransportResult } from '@elastic/transport';
import * as T from '../types';
interface That {
    transport: Transport;
}
/**
  * Cancel a reindex task. Cancel an ongoing reindex task. If `wait_for_completion` is `true` (the default), the response contains the final task state after cancellation. If `wait_for_completion` is `false`, the response contains only `acknowledged: true`.
  * @see {@link https://www.elastic.co/docs/api/doc/elasticsearch#TODO | Elasticsearch API documentation}
  */
export default function CancelReindexApi(this: That, params: T.CancelReindexRequest, options?: TransportRequestOptionsWithOutMeta): Promise<T.CancelReindexResponse>;
export default function CancelReindexApi(this: That, params: T.CancelReindexRequest, options?: TransportRequestOptionsWithMeta): Promise<TransportResult<T.CancelReindexResponse, unknown>>;
export default function CancelReindexApi(this: That, params: T.CancelReindexRequest, options?: TransportRequestOptions): Promise<T.CancelReindexResponse>;
export {};
