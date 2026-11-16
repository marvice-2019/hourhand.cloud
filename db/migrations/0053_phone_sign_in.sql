-- Sign-in by phone (Better Auth's phone-number plugin). The number is stored as +91 and ten digits, the only form the
-- app accepts, so one person can't end up with two accounts under two spellings. A host who signs up by phone gets a
-- placeholder email on the reserved .invalid domain until they add a real one.
alter table users add column phone_number text unique;
alter table users add column phone_number_verified boolean not null default false;
