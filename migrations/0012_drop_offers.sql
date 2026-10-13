-- vNext PR 1b: the «Офферы» catalog is removed (owner decision 13.10).
-- Production inventory on 13.10: offers = 0 rows, feature_offers = 0 rows; no import source reads an Offers sheet.
-- Code stopped reading these tables in PR 1 (claude/v2-01-retire-offers), so this migration is safe after that deploy.
DROP INDEX IF EXISTS idx_feature_offers_offer;
DROP TABLE IF EXISTS feature_offers;
DROP TABLE IF EXISTS offers;
-- statuses that existed only for offers (st_o_*); nothing else references them
DELETE FROM statuses WHERE entity = 'offer';
