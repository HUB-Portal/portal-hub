import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getAuth, guard } from '../auth/context';
import { parse } from '../http/util';
import { prepareExport, type ExportKind } from '../services/exports';
import { isoDate } from '../services/v1';

/** CSV exports. People only (no API keys). */
export async function exportRoutes(app: FastifyInstance): Promise<void> {
  const g = { preHandler: guard({ permission: 'export.run' }), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  const query = z.object({
    from: isoDate,
    to: isoDate,
    include_names: z.enum(['0', '1']).default('0'),
    date_field: z.enum(['created', 'shipped']).default('created'),
    orgId: z.string().uuid().optional(),
  });

  const handler = (kind: ExportKind) => async (req: any, reply: FastifyReply) => {
    const a = getAuth(req);
    const q = parse(query, req.query);
    const out = await prepareExport(a, { ip: req.ip, headers: req.headers }, kind, { from: q.from, to: q.to, includeNames: q.include_names === '1', dateField: q.date_field, orgId: q.orgId });
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${out.filename}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store');
    return reply.send(out.stream);
  };

  app.get('/api/exports/cases.csv', g, handler('cases'));
  app.get('/api/exports/shipments.csv', g, handler('shipments'));
}
