window.AramazdCheckout = {
  dbName: 'aramazd_order_files_db',
  storeName: 'pending_files',

  saveDraft(draft){
    draft.created_at_local = new Date().toISOString();
    localStorage.setItem('aramazd_pending_checkout', JSON.stringify(draft));
  },

  getDraft(){
    try { return JSON.parse(localStorage.getItem('aramazd_pending_checkout') || 'null'); }
    catch(e){ return null; }
  },

  clearDraft(){
    localStorage.removeItem('aramazd_pending_checkout');
  },

  openDb(){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if(!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async savePendingFiles(files){
    const list = Array.from(files || []);
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      store.put(list, 'order_photos');
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  },

  async getPendingFiles(){
    try{
      const db = await this.openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readonly');
        const req = tx.objectStore(this.storeName).get('order_photos');
        req.onsuccess = () => resolve(Array.from(req.result || []));
        req.onerror = () => reject(req.error);
      });
    }catch(e){ return []; }
  },

  async clearPendingFiles(){
    try{
      const db = await this.openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).delete('order_photos');
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    }catch(e){}
  },

  async start(draft, opts = {}){
    this.saveDraft(draft);
    if(opts.photoFiles) await this.savePendingFiles(opts.photoFiles);

    const session = await Aramazd.getSession();
    const loginPath = opts.loginPath || 'login.html';
    const checkoutPath = opts.checkoutPath || 'checkout.html';
    const nextForLogin = opts.next || 'checkout.html';

    if(!session || !session.user){
      location.href = loginPath + '?next=' + encodeURIComponent(nextForLogin);
      return;
    }

    location.href = checkoutPath;
  },

  safeName(name){
    return String(name || 'file').replace(/[^\w.\-]+/g, '_').toLowerCase();
  },

  async upload(bucket, path, file){
    const res = await aramazdClient.storage.from(bucket).upload(path, file, {
      cacheControl: '3600',
      upsert: true,
      contentType: file.type || undefined
    });
    if(res.error) throw res.error;
    return aramazdClient.storage.from(bucket).getPublicUrl(path)?.data?.publicUrl || '';
  },

  async createOrderFromDraft(opts = {}){
    const draft = this.getDraft();
    if(!draft) throw new Error('Պատվերի տվյալները չեն գտնվել։');

    const session = await Aramazd.getSession();
    if(!session || !session.user) throw new Error('Մուտք գործեք պատվերը ավարտելու համար։');

    const user = session.user;
    const profile = await Aramazd.ensureProfile(user);
    const price = Number(draft.price || 0);
    const dueNow = price <= 7000 ? price : 5000;
    const paymentType = price <= 7000 ? 'full_payment' : 'deposit';

    const { data, error } = await aramazdClient.from('orders').insert([{
      user_id: user.id,
      product: draft.product || 'Պատվեր',
      status: 'Նոր պատվեր',
      payment_status: 'Սպասում է հաստատման',
      deposit_amount: dueNow,
      paid_amount: 0,
      remaining_amount: Math.max(price - dueNow, 0),
      final_payment_status: 'Չվճարված',
      customer_name: draft.customer_name || profile?.full_name || user.user_metadata?.full_name || user.email,
      phone: draft.phone || profile?.phone || '',
      price,
      recipient_name: opts.delivery?.recipient_name || '',
      delivery_phone: opts.delivery?.delivery_phone || '',
      delivery_city: opts.delivery?.delivery_city || '',
      delivery_address: opts.delivery?.delivery_address || '',
      postal_code: opts.delivery?.postal_code || '',
      delivery_note: opts.delivery?.delivery_note || '',
      details: { ...(draft.details || {}), payment_type: paymentType, due_now: dueNow, customer_email: user.email }
    }]).select().single();

    if(error) throw error;

    const orderId = data.id;
    const updates = {};

    if(opts.receiptFile){
      updates.receipt_url = await this.upload('receipts', `order-${orderId}/${Date.now()}-${this.safeName(opts.receiptFile.name)}`, opts.receiptFile);
    }

    const photoUrls = [];
    for(const f of (opts.photoFiles || [])){
      photoUrls.push(await this.upload('order-photos', `order-${orderId}/${Date.now()}-${this.safeName(f.name)}`, f));
    }
    if(photoUrls.length) updates.order_photos = photoUrls;

    let finalOrder = data;
    if(Object.keys(updates).length){
      const upd = await aramazdClient.from('orders').update(updates).eq('id', orderId).select().single();
      if(upd.error) throw upd.error;
      finalOrder = upd.data;
    }

    this.clearDraft();
    await this.clearPendingFiles();
    return finalOrder;
  }
};
