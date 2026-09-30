import {
  getApps,
  initializeApp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCqKEvzH2FJk0WNMX80YkCQHjvluaxt_8k",
  authDomain: "hksp25-club-platform.firebaseapp.com",
  projectId: "hksp25-club-platform",
  storageBucket: "hksp25-club-platform.firebasestorage.app",
  messagingSenderId: "354462005967",
  appId: "1:354462005967:web:5e8971d2d0936305dad5ba",
  measurementId: "G-JH5RE960DD",
};

const existingDefaultApp = getApps().find(
  (candidate) => candidate.name === "[DEFAULT]",
);

if (
  existingDefaultApp &&
  (existingDefaultApp.options.projectId !== firebaseConfig.projectId ||
    existingDefaultApp.options.appId !== firebaseConfig.appId)
) {
  throw new Error(
    "Firebase default app configuration conflict: expected projectId " +
      `"${firebaseConfig.projectId}" and appId "${firebaseConfig.appId}", ` +
      `but received projectId "${existingDefaultApp.options.projectId}" ` +
      `and appId "${existingDefaultApp.options.appId}".`,
  );
}

const app = existingDefaultApp ?? initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };
