# SEALED ANSWER KEY: Kanboard blind evaluation (KBE-1, KBE-2)

Date: 2026-11-20
Repository: ihsansengun/kanboard-releaseproof-eval (fork of kanboard/kanboard)
Keep private until the evaluation is finished.

Assignment of the defective head was drawn with `shuf -i 0-1 -n 1`, once per
case, with the rule fixed beforehand "0 = branch a is defective, 1 = branch b".
Both draws came out 0.

| Case | Ticket | Base branch (SHA) | Head | Head SHA | PR | Verdict |
|---|---|---|---|---|---|---|
| H | KBE-1 | eval/h-base (8ab7694bf6320a4f2f00a1a42b1ce01f794c4295) | eval/h-a | 812596f3973ea8dd9c318b1aa0b8ada02cdd52b5 | #3 | **DEFECTIVE** |
| H | KBE-1 | eval/h-base | eval/h-b | 5d1a63d32e85f0823e84aacb01571edb19b45f86 | #4 | fixed |
| S | KBE-2 | eval/s-base (4b3ab6c5fcbb7a9e4552fe5b656597d450b750c8) | eval/s-a | d909fa813f0e10b8dc6eb1427595f3a77bb9abaa | #5 | **DEFECTIVE** |
| S | KBE-2 | eval/s-base | eval/s-b | 0b00f946fd1987248ca85fe2c51363b5e4018019 | #6 | fixed |

Tickets: PR #7 (eval/tickets, 295994f8d44fd9d9ea08a667ba551e4d38a9ae96) adds
eval/tickets/KBE-1.json and eval/tickets/KBE-2.json to main. Not merged.

---------------------------------------------------------------------------

## Case H (KBE-1): genuine historical regression

- Upstream commit X (introduced the feature and the regression):
  4b9cad82c932975a5515573398bb65b879178f46
  "feat: allow attaching screenshots and files when creating a task" (2025-05-11)
- Upstream commit Y (the fix): 915113a526c1d5ab1ad38e7a6615ddd95418314f
  "fix: avoid SQL error when creating tasks with category. Regression introduced by commit 4b9cad8" (2025-05-11)
- Base: eval/h-base = parent of X (6ebf22eea) + the fork's configuration commit
  (cherry-pick of dd356cc34: releaseproof.yml and .releaseproof/), nothing else.
- eval/h-a (PR #3, DEFECTIVE) = base + X's change, one commit.
- eval/h-b (PR #4, fixed) = base + X's change + Y's change, one commit.
  `git diff eval/h-a eval/h-b` touches only app/Controller/TaskCreationController.php
  and is exactly Y's diff.
- Same commit message on both: "feat: attach screenshots and files from the task creation form".

### The defect
File: app/Controller/TaskCreationController.php, method save(), lines 56-57 on eval/h-a:

    $screenshot = $values['screenshot'];
    array_splice($values, 13, 1);

The new hidden form field "screenshot" is removed from the submitted values by
POSITION (index 13) instead of by name. Index 13 is the screenshot field only
in a project that has no categories and a single swimlane. When the form
contains a Category select (project has at least one category) or a Swimlane
select (project has more than one swimlane), the fields shift: another field
is dropped and "screenshot" stays in the values handed to the task model,
which makes the insert fail (no such column). The task is not created.

### What the user sees (defective build)
In a project that has a category, or two swimlanes: fill the New task form
(with or without attachments, with or without choosing a category) and press
Save. The dialog stays open, no "Task created successfully." message, no
error message, and the task is not on the board. In a project with neither,
everything works, including attachments.

### Acceptance criterion violated
KBE-1, 7th criterion: "The existing fields of the form are not affected. A
task created from the form, with or without attachments, keeps the assignee,
column, priority, category and swimlane chosen in the form. This holds for a
project that has categories and for a project with more than one swimlane as
well as for a project that has neither."
(All other KBE-1 criteria hold on both builds; a tester who only uses a fresh
default project sees nothing wrong.)

### Exact reproduction (fresh instance, admin/admin)
1. Sign in as admin / admin.
2. New project "WithCategories" (/?controller=ProjectCreationController&action=create).
3. Project settings > Categories (/?controller=CategoryController&action=index&project_id=N)
   > "Add a new category" > name "Bug" > Save.
4. Open the board, click "+" on the Backlog column, type title "F-cat",
   choose Category "Bug" (choosing it is not even necessary), Save.
   - Expected (and eval/h-b, and base): "Task created successfully.", task on the
     board, task page shows "Category: Bug".
   - Actual on eval/h-a: dialog stays open, no message, task not created.
5. Variant: project "WithSwimlanes", Project settings > Swimlanes > "Add a new
   swimlane" "Lane B"; create a task choosing swimlane "Lane B".
   - Expected: created in Lane B. Actual on eval/h-a: not created.
6. Control: in a project with no category and one swimlane, creating a task
   with files / a pasted image / nothing works on both builds.

### Verified locally (PHP 8.5.12, restrictions applied, fresh container each)
tools: /home/user/kb-prep/tools/vh.cjs (ticket-driven walk-through, Playwright)
- eval/h-base (parent revision + config): AC7 scenarios pass (category, swimlane).
- upstream X itself (4b9cad82c) and upstream Y itself (915113a52) were run first:
  X fails to create the task once the project has a category, Y creates it.
- eval/h-a: AC1-6, AC8 PASS; AC7 FAIL (plain project OK; category project and
  swimlane project: NOT CREATED, with and without a file).
- eval/h-b: AC1-8 all PASS.
- Also rerun with PHP settings approximating the Alpine default php.ini
  (upload_max_filesize=2M, post_max_size=8M, no opcache): same results.

### What a correct QA report should say
- PR #3 (eval/h-a): FAIL / do not release. Task creation is broken in any
  project that has categories (or more than one swimlane): Save does nothing,
  the task is not created, no message. Criterion 7 violated; the attachment
  criteria themselves pass in a default project.
- PR #4 (eval/h-b): PASS. All eight criteria hold.

### Sources of the KBE-1 acceptance criteria (none taken from the defective code path)
1. Section "Add attachments", collapsed, texts: upstream commit X's own UI
   strings (template task_creation/show.php, TaskHelper::renderFileUpload labels),
   identical in X and in Y; ChangeLog line "feat: allow attaching screenshots
   and files when creating a task".
2. Files listed, removable: upstream component file-upload-task-create.js
   (unchanged by Y), observed on upstream Y (915113a52).
3. Files stored as attachments, names/sizes/download: upstream X title and
   ChangeLog; observed on upstream Y.
4. Pasted image previewed and stored as "Screenshot taken <date>.png": upstream
   TaskFileModel::uploadScreenshot naming (pre-existing upstream behaviour for
   task screenshots), observed on upstream Y.
5. Attachments optional, "Task created successfully.": behaviour of the last
   good revision (parent of X) and of Y; message is upstream's.
6. Title required, "The title is required": upstream TaskValidator (pre-existing),
   observed on parent and on Y.
7. Existing fields unaffected incl. category/swimlane projects: behaviour of the
   last good upstream revision (parent of X, verified on eval/h-base) and
   upstream's fix commit Y description ("avoid SQL error when creating tasks
   with category"); verified on Y.
8. "Create another task": pre-existing upstream behaviour (TaskCreationController::afterSave),
   observed on parent and on Y.

---------------------------------------------------------------------------

## Case S (KBE-2): independently seeded defect

- Upstream feature commit F: 1fcd9f697b88e1681fc142f79f9e454a7a16dd54
  "feat(user): allow searching users by exact email address" (2026-10-27).
  Its message: "Emails are matched exactly and case-insensitively so partial
  searches cannot be used to discover other users' addresses."
- Base: eval/s-base = parent of F (81f9ab1d8) + configuration commit (cherry-pick of dd356cc34).
- eval/s-b (PR #6, fixed) = base + F unchanged, one commit.
- eval/s-a (PR #5, DEFECTIVE) = base + F with the seeded defect, one commit.
- Same commit message on both: "feat(user): find users by their complete email address".

### The defect (designed for this evaluation)
File: app/Filter/UserNameFilter.php, method apply(), line 35 on eval/s-a:

    $this->query->ilike(UserModel::TABLE.'.email', $this->value);

Upstream (eval/s-b) has:

    $this->query->eq('LOWER('.UserModel::TABLE.'.email)', strtolower($this->value));

The e-mail comparison is done with SQL LIKE on the raw search term instead of
an equality test. Without wildcards LIKE behaves like a case-insensitive exact
match, so every ordinary test passes; but "%" and "_" typed by the user act as
wildcards, so a partial address plus a wildcard matches. "%@example.com" lists
every user with an address in that domain; "m%@example.com", "mary@%",
"mar_@example.com" work likewise. This defeats the rule that only a complete
address may match (addresses can be discovered piecewise). It affects the
user list search (administrators) and the user autocomplete
(/?controller=UserAjaxController&action=autocomplete&term=..., which any
signed-in user can call), because both use this filter.

To keep the commit self-consistent, the one upstream unit-test assertion that
this code would fail (`findUsernames('%@example.com')` returns nothing, in
tests/units/Filter/UserNameFilterTest.php) is absent from eval/s-a. That is the
only other difference between the two heads.

### Acceptance criterion violated
KBE-2, 3rd criterion: "Only a complete address matches. Searching for
"@example.com", "mary@", "example.com" or "%@example.com" finds no user: the
list shows "No users found." and the page title reads "Users (0)"."
Only the fourth example fails on the defective build; the first three pass.

### Exact reproduction (fresh instance, admin/admin)
1. Sign in as admin / admin.
2. Users management (/?controller=UserListController&action=show) > "New user":
   username jdoe, name John Doe, e-mail John.Doe@example.com, a password. Save.
3. "New user": username msmith, name Mary Smith, e-mail mary@example.com. Save.
4. In the search box of the user list type `%@example.com` and press Enter
   (/?controller=UserListController&action=search&search=%25%40example.com).
   - Expected (eval/s-b): "No users found.", title "Users (0)".
   - Actual on eval/s-a: John Doe and Mary Smith are listed, title "Users (2)".
5. Same through the autocomplete: GET /?controller=UserAjaxController&action=autocomplete&term=%25%40example.com
   - Expected: []. Actual on eval/s-a: both users (also for a signed-in non-administrator).
6. Controls, identical on both builds: "@example.com", "mary@", "example.com"
   find nobody; "mary@example.com", "MARY@example.com", "john.doe@example.com"
   find exactly one user; "jd", "SMITH", "mary" find by username/name.

### Verified locally (PHP 8.5.12, restrictions applied, fresh container each)
tools: /home/user/kb-prep/tools/vs.cjs
- eval/s-a: AC1, AC2, AC4, AC5, AC6, AC7 PASS; AC3 FAIL (only "%@example.com").
- eval/s-b: AC1-7 all PASS.

### What a correct QA report should say
- PR #5 (eval/s-a): FAIL / do not release. A search term with a wildcard and
  part of an address ("%@example.com") returns users by e-mail, so partial
  addresses match; criterion 3 violated. Everything else passes.
- PR #6 (eval/s-b): PASS. All seven criteria hold.

### Sources of the KBE-2 acceptance criteria (none taken from the defective code)
1. Complete address finds the user: upstream F commit message and title;
   upstream test UserNameFilterTest::testFilterByExactEmail; ChangeLog line
   "feat(user): allow searching users by exact email address".
2. Case-insensitive: F commit message ("exactly and case-insensitively");
   testFilterByExactEmail (John.Doe@example.com / john.doe@example.com,
   mary@example.com / MARY@example.com: the ticket uses the test's own data).
3. Only a complete address; the four examples: F commit message ("partial
   searches cannot be used to discover other users' addresses"); upstream test
   testFilterDoesNotMatchPartialEmail, which asserts exactly "@example.com",
   "john@", "example.com" and "%@example.com" return nothing (the ticket uses
   "mary@" for the second because of its test data). "No users found." and the
   "Users (N)" title are upstream's user_list templates/controller (pre-existing).
4. Username/name search as before: upstream test testFilterByUsernameOrName
   ("jd", "smith", "nobody") and behaviour of the parent revision.
5. Empty search lists all users: pre-existing upstream behaviour
   (UserListController::search), observed on upstream F build.
6. Permissions page "Name" field suggestions: upstream DatabaseBackendUserProvider
   uses the same filter and returns id/username/name only; label format from
   upstream's UserAutoCompleteFormatter; observed on the upstream F build (eval/s-b).
7. Administrators only, "Access Forbidden" 403: pre-existing upstream access
   rules, observed on the upstream F build.

---------------------------------------------------------------------------

## Test image and environment notes
- No change was made to .releaseproof/Dockerfile or releaseproof.yml in either
  base branch: both are byte-identical to fork main.
- The real .releaseproof/Dockerfile could not be built locally (Alpine package
  mirror unreachable). All runs used a local variant: FROM the flattened
  upstream runtime image (kb-runtime-flat, PHP 8.5.12, no VOLUME), COPY the
  branch's files, USER 10001:10001, `php -S 0.0.0.0:8080 -t /app`; started with
  --read-only, internal network, tmpfs /data (uid 10001), --cap-drop ALL,
  no-new-privileges, DATA_DIR=/data, LOG_DRIVER=stderr. In all four: uid 10001,
  /app read-only, no name resolution, admin/admin signs in.
- Case H's base is a May 2025 revision of Kanboard running on PHP 8.5; it ran
  without errors locally, also with settings approximating Alpine's default
  php.ini. In CI the upload limit is PHP's default 2M (local runtime: 32M);
  the tickets state no size limits.
- Upstream workflows (.github/workflows) exist on the branches; no check runs
  were present on the PRs at creation time. Nothing was dispatched.
- Known residual hint: the upstream fix commit for case H is public history on
  the fork's main (its message names the regression). A tool that reads the
  default branch's git log could find it.
