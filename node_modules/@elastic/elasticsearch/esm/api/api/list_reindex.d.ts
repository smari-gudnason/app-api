import { Transport, TransportRequestOptions, TransportRequestOptionsWithMeta, TransportRequestOptionsWithOutMeta, TransportResult } from '@elastic/transport';
import * as T from '../types.js';
interface That {
    transport: Transport;
}
/**
  * List active reindex tasks. Get information about all currently running reindex tasks.
  * @see {@link https://www.elastic.co/docs/api/doc/elasticsearch#TODO | Elasticsearch API documentation}
  */
export default function ListReindexApi(this: That, params?: T.ListReindexRequest, options?: TransportRequestOptionsWithOutMeta): Promise<T.ListReindexResponse>;
export default function ListReindexApi(this: That, params?: T.ListReindexRequest, options?: TransportRequestOptionsWithMeta): Promise<TransportResult<T.ListReindexResponse, unknown>>;
export default function ListReindexApi(this: That, params?: T.ListReindexRequest, options?: TransportRequestOptions): Promise<T.ListReindexResponse>;
export {};
//# sourceMappingURL=list_reindex.d.ts.map