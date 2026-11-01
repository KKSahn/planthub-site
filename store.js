/*
  store.js: the site's connection to its database.

  Every page loads this file, after the Supabase library and config.js. Other
  scripts use it through one object, PH. A page waits for PH.ready, which
  settles once it is known who is signed in, and then draws.

  Signing in and out, accounts:
    PH.ready                    settles when the signed-in person is known
    PH.currentUser()            the signed-in account, or null
    PH.signUp({ ... })          make an account; may ask to confirm by email
    PH.signIn(email, password)
    PH.signOut()
    PH.resendConfirmation(email)
    PH.requestPasswordReset(email)   emails a link
    PH.setNewPassword(password)      after arriving by that link
    PH.arrivedBy                "recovery", "signup", "email_change" or ""
    PH.linkProblem              why an emailed link didn't work, or ""
    PH.arrivedHalfway           the first of two email-change links was opened
    PH.connectionProblem()      couldn't reach the database to find out who is here
    PH.updateProfile({ ... })   change name, email, phone or nursery name
    PH.changePassword(old, new)
    PH.deleteAccount()

  Nurseries and listings:
    PH.loadDirectory()          every visible nursery with what it has on offer
    PH.loadNursery(id)          one nursery with what it has on offer
    PH.loadMyNursery()          the signed-in grower's nursery and all listings
    PH.saveNursery({ ... })     change its name, city or specialties
    PH.saveListing({ ... })     add a listing, or change one (give its id)
    PH.removeListing(id)
    PH.confirmListing(id)       "still accurate": the database stamps today
    PH.confirmAll()
    PH.photoUrl(path, small)    the address of a photo, or of its thumbnail
    PH.whileBusy(button, words, work)   a save, with its button saying so

  Anything that talks to the database returns a promise of { ok: true, ... } or
  { ok: false, error }, where error is a sentence fit to show on the page.
*/

const PH = (function () {

  const PHOTO_BUCKET = "listing-photos";
  const PAGE_SIZE = 1000;   // the most the database hands over in one go
  const LISTING_COLUMNS = "id, nursery_id, common, botanical, container, caliper, height, spread, clear_trunk, grades, quantity, price, updated_on, photos";
  const NURSERY_COLUMNS = "id, owner, name, city, state, specialties";

  // Read this before the library clears it from the address: an emailed link
  // lands on a page with what it was for after the #.
  const arrivedHash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const arrivedBy = arrivedHash.get("type") || "";
  // Changing an email takes a link sent to each address. The first one back
  // brings only a message, and no sign of who it was for.
  const arrivedHalfway = arrivedHash.has("message");
  const linkProblem = arrivedHash.get("error_description") || arrivedHash.get("error") || "";

  // If the library didn't load, the site still draws and says it can't connect.
  const db = window.supabase
    ? window.supabase.createClient(PLANTHUB_CONFIG.url, PLANTHUB_CONFIG.publishableKey, {
        global: { fetch: fetchWithTimeLimit },
      })
    : null;

  // A request that never answers mustn't leave "Saving…" up for ever. A minute
  // is long enough for a photo on a slow phone connection.
  function fetchWithTimeLimit(address, options) {
    const stop = new AbortController();
    const timer = setTimeout(function () { stop.abort(); }, 60000);
    return fetch(address, Object.assign({}, options, { signal: stop.signal })).finally(function () { clearTimeout(timer); });
  }

  let me = null;          // the signed-in person, or null
  let mine = null;        // their nursery, once loaded with its listings
  let cantConnect = false;   // true when it couldn't be found out who is here

  // ---- 1. Small helpers ----------------------------------------------------
  const NO_CONNECTION = "Couldn't reach PlantHub. Check your connection and try again.";

  function cleanEmail(email) { return String(email || "").trim().toLowerCase(); }

  function looksLikeEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

  function passwordProblem(password) {
    if (String(password || "").length < 8) return "Use a password of at least 8 characters.";
    if (String(password).length > 72) return "Use a password of 72 characters or fewer.";
    return "";
  }

  // Turn what the database said into a sentence for the page. Our own rules in
  // the database (code P0001) are already written that way; anything else is
  // reported plainly, without passing technical text on to visitors.
  function sentence(error, fallback) {
    if (!error) return fallback;
    const text = String(error.message || "");
    if (error.code === "P0001") return text;
    if (/failed to fetch|network|load failed|abort|timed? ?out/i.test(text) || error.name === "TimeoutError") return NO_CONNECTION;
    if (/rate limit|too many/i.test(text) || error.status === 429) return "Too many tries in a row. Wait a few minutes and try again.";
    // The database's own limits: trying again wouldn't help.
    if (["23514", "22001", "22003"].indexOf(error.code) !== -1) return "One of those is too long or too large. Shorten it and try again.";
    return fallback;
  }

  // A moment from the database as "2026-10-30", in this computer's own time.
  // (The database gives UTC, which by evening is already tomorrow in Florida.)
  function localDay(moment) {
    const date = new Date(moment);
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  }

  function absoluteAddress(page) { return new URL(page, location.href).href; }

  // Run a save with its button saying "Saving…" until the database answers. A
  // failure nobody planned for comes back as an ordinary answer for the page.
  async function whileBusy(button, words, work) {
    const before = button.textContent;
    button.disabled = true;
    button.textContent = words;
    try {
      return await work();
    } catch (error) {
      return { ok: false, error: NO_CONNECTION };
    } finally {
      button.disabled = false;
      button.textContent = before;
    }
  }

  // Ask for every row, a page at a time. `query` makes a fresh request.
  async function allRows(query) {
    let rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await query().range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      rows = rows.concat(data);
      if (data.length < PAGE_SIZE) return rows;
    }
  }

  // ---- 2. Who is here? -----------------------------------------------------
  async function loadMe(user) {
    const [profile, nursery] = await Promise.all([
      db.from("profiles").select("name, phone, account_type, created_at").eq("id", user.id).maybeSingle(),
      db.from("nurseries").select(NURSERY_COLUMNS).eq("owner", user.id).maybeSingle(),
    ]);
    if (profile.error) throw profile.error;
    if (nursery.error) throw nursery.error;
    // The account was deleted while this browser still remembered it.
    if (!profile.data) {
      await db.auth.signOut({ scope: "local" });
      me = null;
      return;
    }
    me = {
      id: user.id,
      type: profile.data.account_type,
      typeName: "Grower",
      name: profile.data.name,
      email: user.email,
      phone: profile.data.phone,
      created: localDay(profile.data.created_at),
      nurseryId: nursery.data ? nursery.data.id : null,
      business: nursery.data ? nursery.data.name : "",
    };
  }

  async function start() {
    if (!db) {
      cantConnect = true;
      return;
    }
    try {
      const { data, error } = await db.auth.getSession();
      if (error && /fetch|network/i.test(String(error.name) + String(error.message))) throw error;
      if (data.session) await loadMe(data.session.user);
    } catch (error) {
      // Browsing still works; the corner just offers "Sign in". A page that
      // needs an account says it can't connect, rather than sending someone who
      // is signed in off to sign in again.
      me = null;
      cantConnect = true;
    }
  }

  function currentUser() { return me ? Object.assign({}, me) : null; }

  // ---- 3. Accounts ---------------------------------------------------------
  async function signUp(details) {
    if (!db) return { ok: false, error: NO_CONNECTION };
    const name = String(details.name || "").trim();
    const email = cleanEmail(details.email);
    if (!name) return { ok: false, field: "name", error: "Enter your name." };
    if (!looksLikeEmail(email)) return { ok: false, field: "email", error: "Enter an email address, like name@example.com." };
    const problem = passwordProblem(details.password);
    if (problem) return { ok: false, field: "password", error: problem };

    const { data, error } = await db.auth.signUp({
      email: email,
      password: details.password,
      options: { data: { name: name }, emailRedirectTo: absoluteAddress("signin.html") },
    });
    if (error) {
      if (/already registered|already exists/i.test(error.message)) {
        return { ok: false, field: "email", error: "There is already an account with that email. Sign in instead." };
      }
      return { ok: false, error: sentence(error, "That didn't work. Try again in a moment.") };
    }
    // No session means the address has to be confirmed first.
    if (!data.session) return { ok: true, needsConfirm: true, email: email };
    await loadMe(data.user);
    return { ok: true, user: currentUser() };
  }

  async function signIn(email, password) {
    if (!db) return { ok: false, error: NO_CONNECTION };
    const { data, error } = await db.auth.signInWithPassword({ email: cleanEmail(email), password: password });
    if (error) {
      if (/not confirmed/i.test(error.message)) {
        return { ok: false, unconfirmed: true, error: "Confirm your email first: the link is in the message we sent when you signed up." };
      }
      if (/invalid/i.test(error.message)) {
        // One message for both mistakes, so the page never confirms which
        // emails have accounts.
        return { ok: false, error: "That email and password don't match an account." };
      }
      return { ok: false, error: sentence(error, "That didn't work. Try again in a moment.") };
    }
    await loadMe(data.user);
    return { ok: true, user: currentUser() };
  }

  async function signOut() {
    if (db) await db.auth.signOut({ scope: "local" });
    me = null;
    mine = null;
  }

  async function resendConfirmation(email) {
    if (!db) return { ok: false, error: NO_CONNECTION };
    const { error } = await db.auth.resend({
      type: "signup",
      email: cleanEmail(email),
      options: { emailRedirectTo: absoluteAddress("signin.html") },
    });
    return error ? { ok: false, error: sentence(error, "That didn't work. Try again in a moment.") } : { ok: true };
  }

  // The same answer whether or not the email has an account.
  async function requestPasswordReset(email) {
    if (!db) return { ok: false, error: NO_CONNECTION };
    const wanted = cleanEmail(email);
    if (!looksLikeEmail(wanted)) return { ok: false, field: "email", error: "Enter an email address, like name@example.com." };
    const { error } = await db.auth.resetPasswordForEmail(wanted, { redirectTo: absoluteAddress("signin.html") });
    return error ? { ok: false, error: sentence(error, "That didn't work. Try again in a moment.") } : { ok: true };
  }

  async function setNewPassword(password, ifItFails) {
    if (!db) return { ok: false, error: NO_CONNECTION };
    const problem = passwordProblem(password);
    if (problem) return { ok: false, field: "password", error: problem };
    const { error } = await db.auth.updateUser({ password: password });
    if (error) {
      if (/different from the old/i.test(error.message)) return { ok: false, field: "password", error: "Choose a password different from your old one." };
      return { ok: false, error: sentence(error, ifItFails || "That link may have run out. Ask for a new one.") };
    }
    return { ok: true };
  }

  async function updateProfile(changes) {
    if (!me) return { ok: false, error: "You are signed out." };
    const name = String(changes.name || "").trim();
    const email = cleanEmail(changes.email);
    const phone = String(changes.phone || "").trim();
    const business = String(changes.business || "").trim();
    if (!name) return { ok: false, field: "name", error: "Enter your name." };
    if (!looksLikeEmail(email)) return { ok: false, field: "email", error: "Enter an email address, like name@example.com." };
    if (!business) return { ok: false, field: "business", error: "Enter the nursery's name." };

    const saved = await db.from("profiles").update({ name: name, phone: phone }).eq("id", me.id);
    if (saved.error) return { ok: false, error: sentence(saved.error, "That didn't save. Try again in a moment.") };
    me.name = name;
    me.phone = phone;

    if (me.nurseryId) {
      const nursery = await db.from("nurseries").update({ name: business }).eq("id", me.nurseryId);
      if (nursery.error) return { ok: false, error: sentence(nursery.error, "That didn't save. Try again in a moment.") };
      me.business = business;
      if (mine) mine.name = business;
    }

    // A new address only takes over once a link sent to it has been opened.
    let emailPending = false;
    if (email !== cleanEmail(me.email)) {
      const { error } = await db.auth.updateUser({ email: email }, { emailRedirectTo: absoluteAddress("signin.html") });
      if (error) {
        if (/already|registered/i.test(error.message)) return { ok: false, field: "email", error: "Another account already uses that email." };
        return { ok: false, error: sentence(error, "Your email didn't change. Try again in a moment.") };
      }
      emailPending = true;
    }
    return { ok: true, user: currentUser(), emailPending: emailPending };
  }

  async function changePassword(oldPassword, newPassword) {
    if (!me) return { ok: false, error: "You are signed out." };
    const problem = passwordProblem(newPassword);
    if (problem) return { ok: false, field: "new", error: problem };
    // Signing in again is what proves the current password.
    const check = await db.auth.signInWithPassword({ email: me.email, password: oldPassword });
    if (check.error) {
      if (/invalid/i.test(check.error.message)) return { ok: false, field: "old", error: "That isn't your current password." };
      return { ok: false, error: sentence(check.error, "That didn't work. Try again in a moment.") };
    }
    return setNewPassword(newPassword, "Your password didn't change. Try again in a moment.");
  }

  // Photos first, because they can only be removed while signed in. Removing
  // the account then takes the profile, nursery and listings with it.
  async function deleteAccount() {
    if (!me) return { ok: false, error: "You are signed out." };
    try {
      const store = db.storage.from(PHOTO_BUCKET);
      for (;;) {
        const { data, error } = await store.list(me.id, { limit: 100 });
        if (error) throw error;
        if (!data.length) break;
        const removed = await store.remove(data.map(function (file) { return me.id + "/" + file.name; }));
        if (removed.error) throw removed.error;
      }
      const { error } = await db.rpc("delete_my_account");
      if (error) throw error;
    } catch (error) {
      return { ok: false, error: sentence(error, "Your account wasn't deleted. Try again in a moment.") };
    }
    await signOut();
    return { ok: true };
  }

  // ---- 4. Reading nurseries and listings ------------------------------------
  // Turn a row from the database into the shape the pages use. A measurement
  // that wasn't given is left out altogether, which is what the pages expect.
  function toPlant(row) {
    const plant = {
      id: row.id,
      common: row.common,
      botanical: row.botanical,
      container: row.container,
      grades: row.grades || [],
      quantity: row.quantity,
      price: Number(row.price),
      updated: row.updated_on,
      photoList: row.photos || [],
      photos: (row.photos || []).length,
    };
    if (row.caliper !== null) plant.caliper = Number(row.caliper);
    if (row.height !== null) plant.height = Number(row.height);
    if (row.spread !== null) plant.spread = Number(row.spread);
    if (row.clear_trunk !== null) plant.clearTrunk = Number(row.clear_trunk);
    return plant;
  }

  function toNursery(row, listingRows) {
    return {
      id: row.id,
      name: row.name,
      city: row.city,
      state: row.state,
      specialties: row.specialties || [],
      plants: listingRows.map(toPlant),
    };
  }

  // Everything the public can see. Listings at zero are held back by the
  // database for everyone but their owner, so they are left out here as well.
  async function loadDirectory() {
    if (!db) return { ok: false, error: NO_CONNECTION };
    try {
      const [nurseryRows, listingRows] = await Promise.all([
        allRows(function () { return db.from("nurseries").select(NURSERY_COLUMNS).order("id"); }),
        allRows(function () { return db.from("listings").select(LISTING_COLUMNS).gt("quantity", 0).order("id"); }),
      ]);
      const byNursery = {};
      listingRows.forEach(function (row) { (byNursery[row.nursery_id] = byNursery[row.nursery_id] || []).push(row); });
      return {
        ok: true,
        nurseries: nurseryRows
          .filter(function (row) { return byNursery[row.id]; })
          .map(function (row) { return toNursery(row, byNursery[row.id]); }),
      };
    } catch (error) {
      return { ok: false, error: sentence(error, "The listings didn't load. Refresh the page to try again.") };
    }
  }

  // One grower's public page. An id that isn't one, or a nursery that is
  // hidden or gone, comes back as { ok: true, nursery: null }.
  async function loadNursery(id) {
    if (!db) return { ok: false, error: NO_CONNECTION };
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return { ok: true, nursery: null };
    try {
      const { data, error } = await db.from("nurseries").select(NURSERY_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw error;
      if (!data) return { ok: true, nursery: null };
      const rows = await allRows(function () {
        return db.from("listings").select(LISTING_COLUMNS).eq("nursery_id", id).gt("quantity", 0).order("id");
      });
      return { ok: true, nursery: toNursery(data, rows) };
    } catch (error) {
      return { ok: false, error: sentence(error, "This page didn't load. Refresh to try again.") };
    }
  }

  // The signed-in grower's own nursery with every listing, newest first,
  // including those at zero.
  async function loadMyNursery() {
    if (!me || !me.nurseryId) return { ok: false, error: "Sign in with a grower account to manage inventory." };
    try {
      const { data, error } = await db.from("nurseries").select(NURSERY_COLUMNS).eq("id", me.nurseryId).single();
      if (error) throw error;
      const rows = await allRows(function () {
        return db.from("listings").select(LISTING_COLUMNS).eq("owner", me.id).order("created_at", { ascending: false }).order("id");
      });
      mine = toNursery(data, rows);
      return { ok: true, nursery: mine };
    } catch (error) {
      return { ok: false, error: sentence(error, "Your inventory didn't load. Refresh the page to try again.") };
    }
  }

  // ---- 5. Changing them -----------------------------------------------------
  async function saveNursery(details) {
    if (!mine) return { ok: false, error: "You are signed out." };
    const name = String(details.name || "").trim();
    // The state is kept separately, so "Wellington, FL" would read "Wellington, FL, FL".
    const city = String(details.city || "").trim().replace(/[,\s]+(fl|fla|florida)\.?(\s+\d{5}(-\d{4})?)?$/i, "").trim();
    if (!name) return { ok: false, field: "nursery-name", error: "Enter the nursery's name." };
    if (!city) return { ok: false, field: "nursery-city", error: "Enter the city, so buyers nearby can find you." };

    const specialties = String(details.specialties || "").split(",").map(function (word) { return word.trim(); }).filter(Boolean);
    const { data, error } = await db.from("nurseries")
      .update({ name: name, city: city, specialties: specialties })
      .eq("id", mine.id).select(NURSERY_COLUMNS).single();
    if (error) return { ok: false, error: sentence(error, "That didn't save. Try again in a moment.") };

    mine.name = data.name;
    mine.city = data.city;
    mine.specialties = data.specialties || [];
    me.business = data.name;
    return { ok: true, nursery: mine };
  }

  // A number typed into a form, or null when the box was left empty.
  function optionalNumber(value) {
    if (value === "" || value === null || value === undefined) return null;
    const number = Number(value);
    return isNaN(number) ? NaN : number;
  }

  function thumbPath(path) { return path.replace(/\.jpg$/, "-thumb.jpg"); }

  // Put new photos in the grower's folder. Each one in the list is either
  // { path, added } (already stored) or { full, thumb } (two pictures to send).
  // Returns the list as { path } entries, and the paths it just stored so they
  // can be taken back out if the listing itself fails to save.
  async function storePhotos(list) {
    const store = db.storage.from(PHOTO_BUCKET);
    const uploaded = [];
    const entries = [];
    try {
      for (const photo of list) {
        if (photo.path) {
          entries.push({ path: photo.path });
          continue;
        }
        const path = me.id + "/" + crypto.randomUUID() + ".jpg";
        const small = await store.upload(thumbPath(path), photo.thumb, { contentType: "image/jpeg" });
        if (small.error) throw small.error;
        uploaded.push(path);
        const large = await store.upload(path, photo.full, { contentType: "image/jpeg" });
        if (large.error) throw large.error;
        entries.push({ path: path });
      }
      return { entries: entries, uploaded: uploaded };
    } catch (error) {
      await removePhotos(uploaded);
      throw error;
    }
  }

  // Take photos out of the store. A picture left behind by a failure here only
  // takes up space: nothing shows it any more, so the save still counts.
  async function removePhotos(paths) {
    if (!paths.length) return;
    const files = [];
    paths.forEach(function (path) { files.push(path, thumbPath(path)); });
    try { await db.storage.from(PHOTO_BUCKET).remove(files); } catch (error) { /* see above */ }
  }

  // Add a listing, or change the one with the given id. The database stamps it
  // with today's date either way: touching a listing is confirming it.
  async function saveListing(details) {
    if (!mine) return { ok: false, error: "You are signed out." };
    const common = String(details.common || "").trim();
    const quantity = Number(details.quantity);
    const price = Number(details.price);

    if (!common) return { ok: false, field: "common", error: "Enter the plant's common name." };
    if (!details.container) return { ok: false, field: "container", error: "Choose a container size." };
    if (details.quantity === "" || !Number.isInteger(quantity) || quantity < 0) {
      return { ok: false, field: "quantity", error: "Enter the exact number you have, as a whole number." };
    }
    if (!(price > 0)) return { ok: false, field: "price", error: "Enter the wholesale price per plant." };
    if (quantity > 100000000) return { ok: false, field: "quantity", error: "That quantity is too large." };
    if (price >= 100000000) return { ok: false, field: "price", error: "That price is too large." };

    const row = {
      common: common,
      botanical: String(details.botanical || "").trim(),
      container: details.container,
      grades: (details.grades || []).slice(),
      quantity: quantity,
      price: Math.round(price * 100) / 100,
    };
    const specNames = { caliper: "Caliper", height: "Height", spread: "Spread", clearTrunk: "Clear trunk" };
    const specColumns = { caliper: "caliper", height: "height", spread: "spread", clearTrunk: "clear_trunk" };
    for (const key in specNames) {
      const number = optionalNumber(details[key]);
      if (number !== null && (isNaN(number) || number <= 0)) {
        return { ok: false, field: key, error: specNames[key] + " must be a number above zero, or left empty." };
      }
      if (number !== null && number >= 100000) return { ok: false, field: key, error: specNames[key] + " is too large." };
      row[specColumns[key]] = number;
    }

    const existing = mine.plants.find(function (plant) { return plant.id === details.id; });
    if (details.id && !existing) return { ok: false, error: "That listing has been removed." };
    const before = existing ? existing.photoList.map(function (photo) { return photo.path; }) : [];

    let stored;
    try {
      stored = await storePhotos(details.photoList || (existing ? existing.photoList : []));
    } catch (error) {
      return { ok: false, error: sentence(error, "A photo didn't upload, so nothing was saved. Try again.") };
    }
    row.photos = stored.entries;

    const request = existing
      ? db.from("listings").update(row).eq("id", existing.id)
      : db.from("listings").insert(row);
    const { data, error } = await request.select(LISTING_COLUMNS).single();
    if (error) {
      await removePhotos(stored.uploaded);
      return { ok: false, error: sentence(error, "That didn't save. Check the details and try again.") };
    }

    const kept = stored.entries.map(function (entry) { return entry.path; });
    await removePhotos(before.filter(function (path) { return kept.indexOf(path) === -1; }));

    const plant = toPlant(data);
    mine.plants = existing
      ? mine.plants.map(function (other) { return other.id === plant.id ? plant : other; })
      : [plant].concat(mine.plants);
    return { ok: true, nursery: mine };
  }

  async function removeListing(id) {
    if (!mine) return { ok: false, error: "You are signed out." };
    const plant = mine.plants.find(function (other) { return other.id === id; });
    const { error } = await db.from("listings").delete().eq("id", id);
    if (error) return { ok: false, error: sentence(error, "That wasn't removed. Try again in a moment.") };
    if (plant) await removePhotos(plant.photoList.map(function (photo) { return photo.path; }));
    mine.plants = mine.plants.filter(function (other) { return other.id !== id; });
    return { ok: true, nursery: mine };
  }

  // "Still accurate", for one listing or for all. The date comes back from the
  // database by loading the listings again.
  async function confirm(onlyId) {
    if (!mine) return { ok: false, error: "You are signed out." };
    const { error } = await db.rpc("confirm_listings", onlyId ? { only_id: onlyId } : {});
    if (error) return { ok: false, error: sentence(error, "That didn't save. Try again in a moment.") };
    return loadMyNursery();
  }

  function confirmListing(id) { return confirm(id); }
  function confirmAll() { return confirm(null); }

  function photoUrl(path, small) {
    if (!db) return "";
    return db.storage.from(PHOTO_BUCKET).getPublicUrl(small ? thumbPath(path) : path).data.publicUrl;
  }

  // ---- 6. The account corner of every page -----------------------------------
  // A page marks where the corner goes with <div data-account-corner></div>.
  // Signed out it holds "Sign in"; signed in, the person's name (a link to
  // their account) and "Sign out".
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  // The light-or-dark switch, first in the corner. theme.js does the
  // switching; this only draws the button: a moon while the page is light
  // (press for dark), a sun while it is dark (press for light).
  const MOON = '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>';
  const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';

  function themeButton() {
    const dark = !!window.PlantHubTheme && window.PlantHubTheme.isDark();
    const label = dark ? "Switch to light mode" : "Switch to dark mode";
    return (
      '<button type="button" class="theme-toggle" data-theme-button aria-label="' + label + '" title="' + label + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          (dark ? SUN : MOON) +
        "</svg>" +
      "</button>"
    );
  }

  // Pages without an account corner (sign in, sign up) mark where the
  // switch goes with <div data-theme-toggle></div>.
  function drawThemeButtons() {
    document.querySelectorAll("[data-theme-toggle]").forEach(function (spot) { spot.innerHTML = themeButton(); });
    document.querySelectorAll("[data-account-corner] [data-theme-button]").forEach(function (button) {
      button.outerHTML = themeButton();
    });
  }

  let cornerKnown = false;

  // Until it is known who is here the corner holds only the switch, so a
  // signed-in person never sees "Sign in" flash up.
  function drawAccountCorner() {
    if (document.readyState === "loading") return;
    document.querySelectorAll("[data-theme-toggle]").forEach(function (spot) { spot.innerHTML = themeButton(); });
    document.querySelectorAll("[data-account-corner]").forEach(function (corner) {
      if (!cornerKnown) {
        corner.innerHTML = themeButton();
        return;
      }
      if (!me) {
        corner.innerHTML = themeButton() + '<a href="signin.html" class="corner-button">Sign in</a>';
        return;
      }
      corner.innerHTML = themeButton() +
        '<a href="inventory.html" class="corner-link">Inventory</a>' +
        '<a href="account.html" class="corner-name" title="Your account">' +
          '<span class="corner-initial" aria-hidden="true">' + escapeHtml(me.name.charAt(0).toUpperCase()) + "</span>" +
          '<span class="corner-text">' + escapeHtml(me.name) + "</span>" +
        "</a>" +
        // On a phone there is no room for this as well; the account page
        // (the round letter) has Sign out under "Leaving".
        '<button type="button" class="corner-button corner-signout" data-sign-out>Sign out</button>';
    });
  }

  // The line at the foot of every page. A page marks where it goes with
  // <p data-site-footer></p>.
  function drawFooters() {
    document.querySelectorAll("[data-site-footer]").forEach(function (spot) {
      spot.innerHTML =
        '<span class="inline-block mr-4">Questions or feedback? <a class="auth-link" href="mailto:hello@theplanthub.co">hello@theplanthub.co</a></span>' +
        '<a class="auth-link inline-block" href="privacy.html">Privacy</a>';
    });
  }

  document.addEventListener("click", function (event) {
    if (!event.target.closest("[data-theme-button]") || !window.PlantHubTheme) return;
    window.PlantHubTheme.toggle();
  });
  document.addEventListener("planthub:theme-changed", drawThemeButtons);

  document.addEventListener("click", async function (event) {
    if (!event.target.closest("[data-sign-out]")) return;
    await signOut();
    // Pages that only make sense signed in send people back to the front.
    if (document.body.hasAttribute("data-needs-account")) location.href = "index.html";
    else location.reload();
  });

  // A page says this when the signed-in person's name changes.
  document.addEventListener("planthub:account-changed", drawAccountCorner);

  function whenPageIsReady() {
    drawAccountCorner();
    drawFooters();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", whenPageIsReady);
  else whenPageIsReady();

  // Pressing Back can bring a page back exactly as it was left, without
  // running it again. A page that belongs to one account (it has
  // data-needs-account) is loaded afresh. Any other page keeps what was typed
  // into it and only redraws this corner.
  window.addEventListener("pageshow", function (event) {
    if (!event.persisted) return;
    if (document.body.hasAttribute("data-needs-account")) location.reload();
    else drawAccountCorner();
  });

  // After signing in, go back to the page that asked for it. Only plain page
  // names from this site are accepted, never an outside address.
  function nextPage(fallback) {
    const wanted = new URLSearchParams(location.search).get("next") || "";
    return /^[a-z0-9-]+\.html([?#][\w=&%.+-]*)?$/i.test(wanted) ? wanted : fallback;
  }

  const ready = start().then(function () {
    cornerKnown = true;
    drawAccountCorner();
  });

  return {
    ready: ready,
    arrivedBy: arrivedBy,
    linkProblem: linkProblem,
    arrivedHalfway: arrivedHalfway,
    connectionProblem: function () { return cantConnect; },
    currentUser: currentUser,
    signUp: signUp,
    signIn: signIn,
    signOut: signOut,
    resendConfirmation: resendConfirmation,
    requestPasswordReset: requestPasswordReset,
    setNewPassword: setNewPassword,
    updateProfile: updateProfile,
    changePassword: changePassword,
    deleteAccount: deleteAccount,
    nextPage: nextPage,
    whileBusy: whileBusy,
    loadDirectory: loadDirectory,
    loadNursery: loadNursery,
    loadMyNursery: loadMyNursery,
    saveNursery: saveNursery,
    saveListing: saveListing,
    removeListing: removeListing,
    confirmListing: confirmListing,
    confirmAll: confirmAll,
    photoUrl: photoUrl,
    escapeHtml: escapeHtml,
  };
})();
