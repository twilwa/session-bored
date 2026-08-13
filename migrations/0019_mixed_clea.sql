-- A send conditions its final write on still holding the claim it took. Without a token, a sender
-- whose lease expired mid-flight would overwrite whoever legitimately took the letter over -
-- including a cancellation, which would report a delivered letter as cancelled.
ALTER TABLE `decision_notice` ADD `sending_claim_token` text;
