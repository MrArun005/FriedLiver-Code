// A Claude chat like the one in a user's screenshot: long multi-line shell
// commands with heredocs (SQL piped into a script, a README written with
// `cat << 'EOF' > README.md`), their output, and a plain-text summary with
// labels, ✓ lists nested under numbered items and file paths. Shaped the way
// FriedLiver's reducer keeps Claude's ACP updates: the title is the command,
// the command and its description are in rawInput, the output arrives as a
// ```console block. Only the UI harness uses it (?fixture=steps).

export const ROOT = '/home/dev/agent_heavy';

const MINIDB_SQL = `CREATE TABLE users (id INT, email TEXT, age INT);
INSERT INTO users VALUES (1, 'alice@example.com', 28);
INSERT INTO users VALUES (2, 'bob@example.com', 35);
INSERT INTO users VALUES (3, 'charlie@example.com', 25);
SELECT * FROM users;
SELECT email, age FROM users WHERE age > 26;
SELECT COUNT(*) FROM users;
SELECT AVG(age) FROM users;
UPDATE users SET age = 30 WHERE email = 'alice@example.com';
SELECT * FROM users ORDER BY age DESC;
DELETE FROM users WHERE age < 30;
SELECT COUNT(*) FROM users;
exit`;

const DEMO_SQL = `-- Advanced demo: JOINs, GROUP BY + HAVING, complex WHERE
CREATE TABLE products (id INT, name TEXT, price INT, category TEXT);
CREATE TABLE orders (id INT, product_id INT, qty INT, amount INT);
INSERT INTO products VALUES (1, 'Laptop', 1000, 'Electronics');
INSERT INTO products VALUES (2, 'Mouse', 25, 'Electronics');
INSERT INTO products VALUES (3, 'Desk', 200, 'Furniture');
INSERT INTO products VALUES (4, 'Chair', 150, 'Furniture');
INSERT INTO orders VALUES (1, 1, 2, 2000);
INSERT INTO orders VALUES (2, 2, 5, 125);
INSERT INTO orders VALUES (3, 3, 1, 200);
INSERT INTO orders VALUES (4, 4, 3, 450);
-- Count orders per product with sum
SELECT product_id, COUNT(*) FROM orders GROUP BY product_id;
-- Top order by amount
SELECT * FROM orders ORDER BY amount DESC LIMIT 1;
-- Aggregates across the whole orders table
SELECT SUM(amount) FROM orders;
SELECT MAX(amount) FROM orders;
DROP TABLE products;
DROP TABLE orders;`;

const README = `# Mini SQL Database Engine

A lightweight, stdlib-only SQL database implementation in Python 3. Supports core SQL
operations with ASCII table output and an interactive REPL mode.

## Features

### DDL (Data Definition Language)
- \`CREATE TABLE\` — Define tables with column types (INT, TEXT, FLOAT)
- \`DROP TABLE\` — Remove tables

### DML (Data Manipulation Language)
- \`INSERT INTO\` — Add rows with type casting
- \`UPDATE\` — Modify rows with an optional WHERE clause
- \`DELETE FROM\` — Remove rows with an optional WHERE clause
- \`SELECT\` — Query with comprehensive features

### SELECT Features
- **Column Selection** — \`SELECT col1, col2\` or \`SELECT *\`
- **WHERE Clause** — \`=\`, \`!=\`, \`<\`, \`>\`, \`<=\`, \`>=\`, \`AND\`, \`OR\`
- **ORDER BY** — Sort by column ASC or DESC
- **LIMIT** — Restrict result rows
- **GROUP BY** / **HAVING** — Aggregate rows by one or more columns
- **Aggregates** — COUNT(*), SUM(), AVG(), MIN(), MAX()

## Installation

No dependencies required. Python 3.8+.

## Usage

\`\`\`bash
python3 minidb.py test.sql      # run a script
python3 minidb.py               # interactive REPL
\`\`\`
`;

const USERS_OUT = `OK: table users created
OK: 1 row inserted
OK: 1 row inserted
OK: 1 row inserted
+----+---------------------+-----+
| id | email               | age |
+----+---------------------+-----+
| 1  | alice@example.com   | 28  |
| 2  | bob@example.com     | 35  |
| 3  | charlie@example.com | 25  |
+----+---------------------+-----+
(3 rows)
+---------------------+-----+
| email               | age |
+---------------------+-----+
| alice@example.com   | 28  |
| bob@example.com     | 35  |
+---------------------+-----+
(2 rows)
+----------+
| COUNT(*) |
+----------+
| 3        |
+----------+
+----------+
| AVG(age) |
+----------+
| 29.33    |
+----------+
OK: 1 row updated
+----+---------------------+-----+
| id | email               | age |
+----+---------------------+-----+
| 2  | bob@example.com     | 35  |
| 1  | alice@example.com   | 30  |
| 3  | charlie@example.com | 25  |
+----+---------------------+-----+
(3 rows)
OK: 1 row deleted
+----------+
| COUNT(*) |
+----------+
| 2        |
+----------+
Bye.`;

export const SUMMARY = `Done. The engine is in ${ROOT}/minidb.py (561 lines), tested and documented.

FEATURES IMPLEMENTED & VERIFIED:
✓ DDL (Data Definition Language)
  - CREATE TABLE (INT, TEXT, FLOAT types)
  - DROP TABLE
✓ DML (Data Manipulation Language)
  - INSERT INTO with type casting
  - UPDATE and DELETE with WHERE
✓ SELECT with WHERE, ORDER BY, LIMIT, GROUP BY + HAVING
✓ Aggregates: COUNT(*), SUM, AVG, MIN, MAX
✗ JOIN (simplified: shows order data only)

TEST RESULTS:
1. test.sql - Core features (22 queries)
   ✓ CREATE TABLE × 2
   ✓ INSERT × 8, UPDATE × 2, DELETE × 1
2. demo_advanced.sql - GROUP BY, HAVING, aggregates (18 queries)
   ✓ All queries return the expected rows

| File | Lines | What |
|---|---:|---|
| minidb.py | 561 | Engine and REPL |
| test.sql | 48 | Core feature tests |
| README.md | 44 | Usage and features |

FILES:
${ROOT}/minidb.py (561 lines) - Main implementation
${ROOT}/test.sql - Test queries
${ROOT}/README.md:12 - Documentation, features at line 12
/tmp/minidb-history.txt - REPL history, outside the workspace

Run it with:
\`\`\`bash
cd ${ROOT} && python3 minidb.py test.sql
\`\`\``;

const console = (text) => [{ t: 'text', text: `\`\`\`console\n${text}\n\`\`\`` }];
const input = (command, description) => JSON.stringify({ command, description }, null, 2).slice(0, 4096);

/** A Claude Bash step as the reducer keeps it. */
function bash(id, command, description, output, extra = {}) {
  return {
    kind: 'tool',
    id,
    title: command,
    toolKind: 'execute',
    status: 'completed',
    locations: [],
    ...(output ? { out: console(output) } : {}),
    input: input(command, description),
    cmd: { line: command },
    about: description,
    ...extra,
  };
}

export const COMMANDS = {
  test: `cd ${ROOT} && python3 minidb.py test.sql 2>&1`,
  users: `cat << 'EOF' | python3 ${ROOT}/minidb.py\n${MINIDB_SQL}\nEOF`,
  list: `ls -lh ${ROOT}/ && wc -l ${ROOT}/minidb.py ${ROOT}/test.sql`,
  demo: `cat << 'EOF' > ${ROOT}/demo_advanced.sql\n${DEMO_SQL}\nEOF\npython3 ${ROOT}/minidb.py ${ROOT}/demo_advanced.sql`,
  readme: `cat << 'EOF' > ${ROOT}/README.md\n${README}EOF`,
  failing: `python3 ${ROOT}/minidb.py --strict ${ROOT}/broken.sql`,
};

export function stepsFixture(now = Date.now()) {
  const min = (m) => now - m * 60_000;
  const items = [
    { kind: 'user', text: 'Build a small SQL database engine in Python (stdlib only), test it and write a README.', images: [] },
    { kind: 'agent', text: "I'll write the engine, run the test script, try more queries through stdin and document it." },
    bash('toolu_test', COMMANDS.test, 'Run the core test script', 'OK: 22 queries, 0 failures', { exit: 0, ms: 412 }),
    bash('toolu_users', COMMANDS.users, 'Try the engine with queries from stdin', USERS_OUT, { exit: 0, ms: 380 }),
    // In Ask mode Claude asked first; the answered request stays as one line.
    {
      kind: 'permission',
      requestId: 'perm-users',
      toolCallId: 'toolu_users',
      title: COMMANDS.users,
      toolKind: 'execute',
      options: [
        { optionId: 'allow', name: 'Yes', kind: 'allow_once' },
        { optionId: 'reject', name: 'No', kind: 'reject_once' },
      ],
      answer: 'Yes',
      detail: { command: { line: COMMANDS.users, cwd: ROOT } },
    },
    bash(
      'toolu_ls',
      COMMANDS.list,
      'List the files and count lines',
      `total 40K\n-rw-r--r-- 1 dev dev 21K Oct 17 10:02 minidb.py\n-rw-r--r-- 1 dev dev 1.9K Oct 17 10:01 test.sql\n  561 ${ROOT}/minidb.py\n   48 ${ROOT}/test.sql\n  609 total`,
    ),
    bash(
      'toolu_demo',
      COMMANDS.demo,
      'Write the advanced demo script and run it',
      '+------------+----------+\n| product_id | COUNT(*) |\n+------------+----------+\n| 1          | 1        |\n| 2          | 1        |\n| 3          | 1        |\n| 4          | 1        |\n+------------+----------+\n(4 rows)\nOK: 18 queries',
    ),
    {
      ...bash('toolu_fail', COMMANDS.failing, 'Check strict mode rejects bad SQL', 'Exit code 2\nError: line 3: unknown column "nmae" in SELECT\nHint: did you mean "name"?'),
      status: 'failed',
    },
    bash('toolu_readme', COMMANDS.readme, 'Write the README', ''),
    { kind: 'tool', id: 'toolu_read', title: 'Read minidb.py (1 - 80)', toolKind: 'read', status: 'completed', locations: [`${ROOT}/minidb.py`] },
    { kind: 'tool', id: 'toolu_grep', title: 'grep -n "def execute" minidb.py', toolKind: 'search', status: 'completed', locations: [] },
    { kind: 'agent', text: SUMMARY },
  ];
  const chat = {
    id: 'chat-sql',
    agent: 'claude',
    label: 'Claude 2',
    title: 'Build a small SQL database engine',
    cwd: ROOT,
    createdAt: min(20),
    busy: false,
    changedFiles: 0,
    items,
    depth: 0,
    files: [],
    lastActivity: min(1),
    turns: 1,
  };
  return { state: { chats: [chat], images: [], links: [] }, ids: { chat: chat.id } };
}
