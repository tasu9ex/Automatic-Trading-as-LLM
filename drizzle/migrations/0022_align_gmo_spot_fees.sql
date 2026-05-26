-- GMO 取引所現物 手数料を公式 2 ティアに揃える。
-- Tier A (BTC/ETH/XRP/DAI): Maker -0.01% / Taker 0.05% ← 既存値と一致
-- Tier B (上記以外):        Maker -0.03% / Taker 0.09% ← これまで 0.05% で過小評価していた
-- 参照: https://coin.z.com/jp/corp/guide/fees/
UPDATE "coins"
SET "maker_fee_rate" = '-0.0003',
    "taker_fee_rate" = '0.0009',
    "updated_at" = now()
WHERE "symbol" NOT IN ('BTC', 'ETH', 'XRP', 'DAI');

UPDATE "coins"
SET "maker_fee_rate" = '-0.0001',
    "taker_fee_rate" = '0.0005',
    "updated_at" = now()
WHERE "symbol" IN ('BTC', 'ETH', 'XRP', 'DAI');
