const { DocStore, MemoryStorageAdapter, Table, createFromTemplate, TEMPLATES } = require('./js-doc-store');

let pass = 0, fail = 0;
function assert(l, c) { if(c){pass++}else{fail++;console.log('  FAIL:',l)} }

const db = new DocStore(new MemoryStorageAdapter());

console.log('=== Test Table + Schema + Views + Templates ===\n');

// 1. Custom schema
console.log('1. CUSTOM SCHEMA');
const contacts = new Table(db, 'contacts', {
  columns: [
    { name: 'Name',   type: 'text',   required: true },
    { name: 'Email',  type: 'email',  unique: true },
    { name: 'Age',    type: 'number' },
    { name: 'Active', type: 'checkbox', default: true },
    { name: 'Status', type: 'select', options: ['Lead', 'Active', 'Churned'] },
    { name: 'Tags',   type: 'multiselect', options: ['VIP', 'Enterprise', 'SMB'] },
    { name: 'Website',type: 'url' },
    { name: 'Phone',  type: 'phone' },
  ]
});

const alice = contacts.insert({ Name: 'Alice', Email: 'alice@test.com', Age: 30, Status: 'Lead' });
assert('insert valid', !!alice._id);
assert('default applied', alice.Active === true);

let err = false;
try { contacts.insert({ Email: 'no@t.com' }); } catch { err = true; }
assert('required name', err);

err = false;
try { contacts.insert({ Name: 'X', Email: 'bad' }); } catch { err = true; }
assert('email validated', err);

err = false;
try { contacts.insert({ Name: 'X', Email: 'x@t.com', Status: 'Bad' }); } catch { err = true; }
assert('select validated', err);

err = false;
try { contacts.insert({ Name: 'X', Email: 'x2@t.com', Tags: ['VIP', 'Bad'] }); } catch { err = true; }
assert('multiselect validated', err);

const bob = contacts.insert({ Name: 'Bob', Email: 'bob@t.com', Tags: ['VIP', 'Enterprise'], Status: 'Active' });
assert('multiselect valid', bob.Tags.length === 2);

err = false;
try { contacts.insert({ Name: 'Dup', Email: 'alice@test.com' }); } catch { err = true; }
assert('unique email', err);

err = false;
try { contacts.insert({ Name: 'X', Email: 'x3@t.com', Website: 'bad' }); } catch { err = true; }
assert('url validated', err);

const charlie = contacts.insert({ Name: 'Charlie', Email: 'c@t.com', Website: 'https://x.com', Phone: '+1 555' });
assert('url+phone valid', !!charlie._id);

err = false;
try { contacts.insert({ Name: 'X', Email: 'x4@t.com', Age: 'NaN' }); } catch { err = true; }
assert('number validated', err);

console.log('  ' + contacts.count() + ' contacts\n');

// 2. Validated update
console.log('2. VALIDATED UPDATE');
contacts.update({ Name: 'Alice' }, { $set: { Status: 'Active' } });
assert('valid update', contacts.findOne({ Name: 'Alice' }).Status === 'Active');

err = false;
try { contacts.update({ Name: 'Alice' }, { $set: { Status: 'Bad' } }); } catch { err = true; }
assert('invalid update rejected', err);

err = false;
try { contacts.update({ Name: 'Alice' }, { $set: { Email: 'bad' } }); } catch { err = true; }
assert('invalid email update rejected', err);

// 3. Views
console.log('\n3. VIEWS');
contacts.createView('active', { filter: { Status: 'Active' }, sort: { Name: 1 } });
contacts.createView('vip', { filter: { Tags: { $contains: 'VIP' } } });
assert('listViews', contacts.listViews().length === 2);

const activeView = contacts.view('active');
assert('view results', activeView.length >= 1);
assert('view filtered', activeView.every(r => r.Status === 'Active'));
console.log('  Active:', activeView.length);

contacts.dropView('vip');
assert('drop view', contacts.listViews().length === 1);

// 4. Schema management
console.log('\n4. SCHEMA MANAGEMENT');
assert('getSchema', contacts.getSchema().columns.length === 8);
contacts.addColumn({ name: 'Score', type: 'number', default: 0 });
assert('addColumn', contacts.getSchema().columns.length === 9);
contacts.renameColumn('Score', 'Rating');
assert('renameColumn', contacts._colMap.has('Rating'));
contacts.removeColumn('Rating');
assert('removeColumn', contacts.getSchema().columns.length === 8);

// 5. Autonumber
console.log('\n5. AUTONUMBER');
const tasks = new Table(db, 'tasks', {
  columns: [
    { name: 'Title', type: 'text', required: true },
    { name: 'Num', type: 'autonumber' },
  ]
});
const t1 = tasks.insert({ Title: 'A' });
const t2 = tasks.insert({ Title: 'B' });
assert('autonumber', t1.Num === 1 && t2.Num === 2);
console.log('  Numbers:', t1.Num, t2.Num);

// 6. Templates
console.log('\n6. TEMPLATES');
assert('4 templates', Object.keys(TEMPLATES).length === 4);

const crm = createFromTemplate(db, 'crm', 'crm');
const lead = crm.insert({ Name: 'Diana', Email: 'diana@co.com' });
assert('CRM defaults', lead.Status === 'Lead' && lead.Revenue === 0 && !!lead.CreatedAt);

const board = createFromTemplate(db, 'board', 'tasks');
const task = board.insert({ Title: 'First' });
assert('tasks template', task.Status === 'Todo' && task.Priority === 'Medium' && task.Number === 1);

const inv = createFromTemplate(db, 'inv', 'inventory');
const prod = inv.insert({ SKU: 'X-1', Name: 'GPU', Price: 999 });
assert('inventory template', prod.Active === true && prod.Stock === 0);

const blog = createFromTemplate(db, 'blog', 'content');
const post = blog.insert({ Title: 'Hello' });
assert('content template', post.Status === 'Draft');

console.log('  Templates:', Object.keys(TEMPLATES).join(', '));

// 7. Relations
console.log('\n7. RELATIONS');
const companies = db.collection('companies');
companies.insert({ _id: 'co1', name: 'Acme', industry: 'Tech' });

const emps = new Table(db, 'emps', {
  columns: [
    { name: 'Name', type: 'text', required: true },
    { name: 'Company', type: 'relation', collection: 'companies' },
  ]
});
const emp = emps.insert({ Name: 'Eve', Company: 'co1' });
const expanded = emps.expandRelations(emps.findById(emp._id));
assert('relation expanded', expanded.Company.name === 'Acme');
console.log('  Eve →', expanded.Company.name);

// 8. Persistence
console.log('\n8. PERSISTENCE');
contacts.flush();
const viewsSaved = db._adapter.readJson('contacts.views.json');
assert('views persisted', viewsSaved && Object.keys(viewsSaved).length === 1);
const schemaSaved = db._adapter.readJson('contacts.schema.json');
assert('schema persisted', schemaSaved && schemaSaved.columns.length === 8);

// 9. Existing tests still pass
console.log('\n' + '='.repeat(50));
console.log('PASSED:', pass, ' FAILED:', fail);
if (fail > 0) process.exit(1);
