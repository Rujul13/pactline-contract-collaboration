CREATE TABLE `mutation_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`satisfied` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "mutation_guards_satisfied" CHECK("mutation_guards"."satisfied" = 1)
);
