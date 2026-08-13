-- Cancelling a letter supersedes every preview still outstanding for that submission. Without
-- this, a batch previewed before a correction could still be dispatched afterwards, reinstating
-- the recipient and copy the correction replaced.
ALTER TABLE `decision_batch_item` ADD `superseded_at` integer;
