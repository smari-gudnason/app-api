import { Transport, TransportRequestOptions, TransportRequestOptionsWithMeta, TransportRequestOptionsWithOutMeta, TransportResult } from '@elastic/transport';
import * as T from '../types.js';
interface That {
    transport: Transport;
}
/**
  * Get a reindex task. Get the status and progress of a specific reindex task.
  * @see {@link https://www.elastic.co/docs/api/doc/elasticsearch#TODO | Elasticsearch API documentation}
  */
export default function GetReindexApi(this: That, params: T.GetReindexRequest, options?: TransportRequestOptionsWithOutMeta): Promise<T.GetReindexResponse>;
export default function GetReindexApi(this: That, params: T.GetReindexRequest, options?: TransportRequestOptionsWithMeta): Promise<TransportResult<T.GetReindexResponse, unknown>>;
export default function GetReindexApi(this: That, params: T.GetReindexRequest, options?: TransportRequestOptions): Promise<T.GetReindexResponse>;
export {};
//# sourceMappingURL=get_reindex.d.ts.map