-- K Line staff have one role now: kl_admin. The roles kl_intake, kl_production, kl_quality and kl_finance are gone, and their
-- permissions all belong to kl_admin. Anybody who still holds one of the old roles becomes a K Line administrator, and the
-- production site restriction (only used by kl_production) is cleared.
UPDATE users u
   SET roles = ARRAY['kl_admin'], site_ids = '{}', updated_at = now()
  FROM organizations o
 WHERE o.id = u.org_id AND o.kind = 'kline'
   AND u.roles && ARRAY['kl_intake', 'kl_production', 'kl_quality', 'kl_finance'];
