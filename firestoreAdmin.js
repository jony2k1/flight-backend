// firestoreAdmin.js — server-side Firestore writes via the Admin SDK.
//
// Why this exists: the direct client → Firestore write from the iOS app was
// found to silently never reach the server on the user's network (reads work
// fine, writes don't — confirmed via direct Firestore console queries after
// waiting well past any reasonable timeout, with no error anywhere). Rather
// than depend on that same network path, the client now sends the write to
// this backend over plain HTTPS (already proven reliable from that device)
// and the backend performs the actual Firestore write using this admin
// credential, which is unaffected by the client's network path entirely.
const admin = require("firebase-admin");
const { parseServiceAccount } = require("./push");

let app = null;
function getApp() {
  if (app) return app;
  const sa = parseServiceAccount(process.env.FCM_SERVICE_ACCOUNT || "");
  if (!sa) return null;
  app = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: sa.project_id,
      clientEmail: sa.client_email,
      privateKey: sa.private_key,
    }),
  });
  return app;
}

const enabled = () => !!getApp();

async function verifyIdToken(idToken) {
  const a = getApp();
  if (!a) throw new Error("firestore admin not configured");
  return admin.auth(a).verifyIdToken(idToken);
}

async function addFlight(idToken, flight) {
  const decoded = await verifyIdToken(idToken);
  const a = getApp();
  const db = admin.firestore(a);
  const payload = { ...flight, userId: decoded.uid, createdAt: admin.firestore.Timestamp.now() };
  const ref = await db.collection("flights").add(payload);
  return { id: ref.id };
}

async function deleteFlight(idToken, firebaseId) {
  const decoded = await verifyIdToken(idToken);
  const a = getApp();
  const db = admin.firestore(a);
  const doc = await db.collection("flights").doc(firebaseId).get();
  if (!doc.exists) return { deleted: false, reason: "not_found" };
  if (doc.data()?.userId !== decoded.uid) return { deleted: false, reason: "not_owner" };
  await doc.ref.delete();
  return { deleted: true };
}

module.exports = { enabled, addFlight, deleteFlight };
