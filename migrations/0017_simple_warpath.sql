-- A send claims its letter before calling the provider, so cancelling and sending cannot both
-- act on the same letter. `sending_since` records when the claim was taken, which is what lets an
-- abandoned claim be recognised rather than stranding the letter forever.
--
-- `delivery_status` gains a `sending` value. The column is plain TEXT with no CHECK constraint,
-- so the new value needs no DDL of its own.
ALTER TABLE `decision_notice` ADD `sending_since` integer;
