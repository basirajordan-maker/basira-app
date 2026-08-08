/* ============================================================
   بصيرة — الطبقة ٣: طبقة الوصول (Data Access Layer)
   Basira — Layer 3: basira-api.js

   القاعدة الذهبية: الواجهة لا تتكلم مع Supabase مباشرة أبداً.
   كل شيء يمر من هنا. هيك أي تغيير بالباك اند = تعديل بمكان واحد.

   كيف تستعمله بأي صفحة HTML:
   ------------------------------------------------
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
   <script src="basira-api.js"></script>
   <script>
     BasiraAPI.init('YOUR_PROJECT_URL', 'YOUR_ANON_KEY');
     // بعدها: await BasiraAPI.auth.login(...)
   </script>
   ------------------------------------------------

   ملاحظة أمان: الـ ANON KEY آمن للواجهة — مصمّم لهيك.
   الحماية الحقيقية في RLS بقاعدة البيانات (الطبقة ١).
   لا تحط هنا أبداً: service_role key أو أي مفتاح سرّي.
   ============================================================ */

const BasiraAPI = (() => {
  let sb = null;          // Supabase client
  let ctx = null;         // سياق الجلسة (my_context)

  /* ---------- تهيئة ---------- */
  function init(projectUrl, anonKey) {
    if (!projectUrl || !anonKey) throw new Error('BASIRA_INIT_MISSING_KEYS');
    sb = supabase.createClient(projectUrl, anonKey);
    return true;
  }

  function client() {
    if (!sb) throw new Error('BASIRA_NOT_INITIALIZED');
    return sb;
  }

  /* ---------- مساعدات داخلية ---------- */
  async function rpc(fn, args = {}) {
    const { data, error } = await client().rpc(fn, args);
    if (error) throw new Error(error.message);
    return data;
  }

  function requireMerchant() {
    if (!ctx || !ctx.membership || !ctx.membership.merchant_id) {
      throw new Error('NO_MERCHANT_CONTEXT');
    }
    return ctx.membership.merchant_id;
  }

  /* ============================================================
     AUTH — الدخول، التسجيل، الجلسة
     ============================================================ */
  const auth = {

    /* تسجيل حساب جديد: مستخدم + تاجر كامل بضربة واحدة */
    async register({ email, password, merchantName, ownerName, businessType = null, phone = null }) {
      const { data, error } = await client().auth.signUp({ email, password });
      if (error) throw new Error(error.message);
      if (!data.session) {
        // المشروع مضبوط على تأكيد الإيميل — المستخدم لازم يأكد أول
        return { needsEmailConfirm: true };
      }
      // المستخدم مسجّل دخول — كوّن له مساحته
      const merchantId = await rpc('signup_merchant', {
        p_merchant_name: merchantName,
        p_owner_name: ownerName,
        p_business_type: businessType,
        p_phone: phone
      });
      await auth.loadContext();
      return { needsEmailConfirm: false, merchantId };
    },

    /* إكمال التسجيل بعد تأكيد الإيميل (لو التأكيد مفعّل) */
    async completeSignup({ merchantName, ownerName, businessType = null, phone = null }) {
      const merchantId = await rpc('signup_merchant', {
        p_merchant_name: merchantName,
        p_owner_name: ownerName,
        p_business_type: businessType,
        p_phone: phone
      });
      await auth.loadContext();
      return merchantId;
    },

    /* تسجيل الدخول */
    async login(email, password) {
      const { error } = await client().auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      await auth.loadContext();
      return ctx;
    },

    /* تسجيل الخروج */
    async logout() {
      await client().auth.signOut();
      ctx = null;
    },

    /* تحميل سياق الجلسة: مين أنا، أي تاجر، أي صلاحيات */
    async loadContext() {
      ctx = await rpc('my_context');
      return ctx;
    },

    /* السياق الحالي (بدون نداء جديد) */
    context() { return ctx; },

    /* هل في جلسة نشطة؟ (يُستدعى عند فتح أي صفحة) */
    async restoreSession() {
      const { data } = await client().auth.getSession();
      if (data.session) { await auth.loadContext(); return ctx; }
      return null;
    }
  };

  /* ============================================================
     PRODUCTS — المنتجات والمتغيّرات والمخزون
     ============================================================ */
  const products = {

    /* رفع صورة منتج لتخزين Supabase — يرجع الرابط العام */
    async uploadImage(file) {
      const merchantId = requireMerchant();
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = merchantId + '/' + Date.now() + '.' + ext;
      const { error } = await client().storage.from('product-images').upload(path, file, { upsert: false });
      if (error) throw new Error(error.message);
      const { data } = client().storage.from('product-images').getPublicUrl(path);
      return data.publicUrl;
    },

    /* كل منتجات التاجر مع متغيّراتها */
    async list() {
      const { data, error } = await client()
        .from('products')
        .select('*, variants(*)')
        .eq('merchant_id', requireMerchant())
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return data;
    },

    /* إضافة منتج مع متغيّراته دفعة واحدة */
    async create({ name, category = null, description = null, price = 0, imageUrl = null, variants = [] }) {
      const merchantId = requireMerchant();
      const { data: prod, error } = await client()
        .from('products')
        .insert({ merchant_id: merchantId, name, category, description, price, image_url: imageUrl })
        .select().single();
      if (error) throw new Error(error.message);

      if (variants.length) {
        const rows = variants.map(v => ({
          product_id: prod.id, merchant_id: merchantId,
          color: v.color || null, color_hex: v.colorHex || null,
          size: v.size || null, stock: v.stock || 0,
          price: (v.price === 0 || v.price) ? v.price : null
        }));
        const { error: e2 } = await client().from('variants').insert(rows);
        if (e2) throw new Error(e2.message);
      }
      return prod;
    },

    /* تعديل منتج */
    async update(productId, fields) {
      const { data, error } = await client()
        .from('products')
        .update(fields)
        .eq('id', productId)
        .eq('merchant_id', requireMerchant())
        .select().single();
      if (error) throw new Error(error.message);
      return data;
    },

    /* إزالة ذكية:
       - بدون طلبات → حذف فيزيائي كامل + حذف صورته من التخزين
       - له طلبات → أرشفة (is_active=false) + حذف صورته (توفير تخزين)
       ترجع: { removed: true } أو { archived: true } */
    async smartRemove(productId) {
      const merchantId = requireMerchant();
      /* اجلب المنتج وصورته ومتغيّراته */
      const { data: prod, error: e0 } = await client()
        .from('products')
        .select('id, image_url, variants(id)')
        .eq('id', productId)
        .eq('merchant_id', merchantId)
        .single();
      if (e0) throw new Error(e0.message);

      /* هل لأي متغيّر طلبات؟ */
      const varIds = (prod.variants || []).map(v => v.id);
      let hasOrders = false;
      if (varIds.length) {
        const { count, error: e1 } = await client()
          .from('order_items')
          .select('id', { count: 'exact', head: true })
          .in('variant_id', varIds);
        if (e1) throw new Error(e1.message);
        hasOrders = (count || 0) > 0;
      }

      /* احذف الصورة من التخزين بالحالتين (أثقل شي) */
      if (prod.image_url) {
        try {
          const marker = '/product-images/';
          const idx = prod.image_url.indexOf(marker);
          if (idx > -1) {
            const path = decodeURIComponent(prod.image_url.slice(idx + marker.length));
            await client().storage.from('product-images').remove([path]);
          }
        } catch (_) { /* فشل حذف الصورة لا يوقف العملية */ }
      }

      if (!hasOrders) {
        /* حذف فيزيائي كامل */
        const { error } = await client()
          .from('products')
          .delete()
          .eq('id', productId)
          .eq('merchant_id', merchantId);
        if (error) throw new Error(error.message);
        return { removed: true };
      } else {
        /* أرشفة مخفية — السجل النصي الخفيف يبقى لحماية الفواتير */
        const { error } = await client()
          .from('products')
          .update({ is_active: false, image_url: null })
          .eq('id', productId)
          .eq('merchant_id', merchantId);
        if (error) throw new Error(error.message);
        return { archived: true };
      }
    },

    /* حذف منتج (ومتغيّراته تلقائياً عبر cascade) */
    async remove(productId) {
      const { error } = await client()
        .from('products')
        .delete()
        .eq('id', productId)
        .eq('merchant_id', requireMerchant());
      if (error) throw new Error(error.message);
      return true;
    },

    /* إضافة متغيّر لمنتج */
    async addVariant(productId, { color = null, colorHex = null, size = null, stock = 0, price = null }) {
      const { data, error } = await client()
        .from('variants')
        .insert({
          product_id: productId, merchant_id: requireMerchant(),
          color, color_hex: colorHex, size, stock, price
        })
        .select().single();
      if (error) throw new Error(error.message);
      return data;
    },

    /* تعديل متغيّر (كمية، لون، مقاس) */
    async updateVariant(variantId, fields) {
      const { data, error } = await client()
        .from('variants')
        .update(fields)
        .eq('id', variantId)
        .eq('merchant_id', requireMerchant())
        .select().single();
      if (error) throw new Error(error.message);
      return data;
    },

    /* حذف متغيّر */
    async removeVariant(variantId) {
      const { error } = await client()
        .from('variants')
        .delete()
        .eq('id', variantId)
        .eq('merchant_id', requireMerchant());
      if (error) throw new Error(error.message);
      return true;
    }
  };

  /* ============================================================
     INVENTORY — الحجز والمخزون (منع البيع المزدوج)
     ============================================================ */
  const inventory = {
    /* احجز كمية (true = نجح، false = المتاح لا يكفي) */
    async reserve(variantId, qty) {
      return await rpc('reserve_variant', { p_variant_id: variantId, p_qty: qty });
    },
    /* ثبّت البيع بعد التسليم */
    async commit(variantId, qty) {
      return await rpc('commit_variant', { p_variant_id: variantId, p_qty: qty });
    },
    /* حرّر الحجز (طلب ملغى) */
    async release(variantId, qty) {
      return await rpc('release_variant', { p_variant_id: variantId, p_qty: qty });
    }
  };

  /* ============================================================
     CUSTOMERS — عملاء التاجر
     ============================================================ */
  const customers = {
    async list() {
      const { data, error } = await client()
        .from('customers')
        .select('*')
        .eq('merchant_id', requireMerchant())
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return data;
    },

    /* إيجاد عميل بمعرّفه على المنصة، أو إنشاؤه (بصيرة "تتذكّر") */
    async findOrCreate({ socialId, channelType, name = null, phone = null }) {
      const merchantId = requireMerchant();
      const { data: existing } = await client()
        .from('customers')
        .select('*')
        .eq('merchant_id', merchantId)
        .eq('channel_type', channelType)
        .eq('social_id', socialId)
        .maybeSingle();
      if (existing) return existing;

      const { data, error } = await client()
        .from('customers')
        .insert({ merchant_id: merchantId, social_id: socialId, channel_type: channelType, name, phone })
        .select().single();
      if (error) throw new Error(error.message);
      return data;
    }
  };

  /* ============================================================
     CONVERSATIONS — المحادثات والرسائل (ذاكرة بصيرة)
     ============================================================ */
  const conversations = {
    async list(status = null) {
      let q = client()
        .from('conversations')
        .select('*, customers(name, social_id, channel_type)')
        .eq('merchant_id', requireMerchant())
        .order('last_msg_at', { ascending: false });
      if (status) q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return data;
    },

    async messages(conversationId) {
      const { data, error } = await client()
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .eq('merchant_id', requireMerchant())
        .order('created_at', { ascending: true });
      if (error) throw new Error(error.message);
      return data;
    },

    async open(customerId, channelId = null) {
      const { data, error } = await client()
        .from('conversations')
        .insert({ merchant_id: requireMerchant(), customer_id: customerId, channel_id: channelId })
        .select().single();
      if (error) throw new Error(error.message);
      return data;
    },

    async addMessage(conversationId, { sender, content, msgType = 'text' }) {
      const merchantId = requireMerchant();
      const { data, error } = await client()
        .from('messages')
        .insert({ conversation_id: conversationId, merchant_id: merchantId, sender, content, msg_type: msgType })
        .select().single();
      if (error) throw new Error(error.message);
      await client().from('conversations')
        .update({ last_msg_at: new Date().toISOString() })
        .eq('id', conversationId).eq('merchant_id', merchantId);
      return data;
    },

    async setStatus(conversationId, status) {
      const { error } = await client()
        .from('conversations')
        .update({ status })
        .eq('id', conversationId)
        .eq('merchant_id', requireMerchant());
      if (error) throw new Error(error.message);
      return true;
    }
  };

  /* ============================================================
     ORDERS — الطلبات (من محادثة لطلب لتسليم)
     ============================================================ */
  const orders = {
    async list(status = null) {
      let q = client()
        .from('orders')
        .select('*, customers(name, phone, channel_type), order_items(*, variants(color, size, products(name)))')
        .eq('merchant_id', requireMerchant())
        .order('created_at', { ascending: false });
      if (status) q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return data;
    },

    /* إنشاء طلب: يحجز الكميات أولاً، ثم يكوّن الطلب.
       items: [{ variantId, quantity, unitPrice }] */
    async create({ customerId, conversationId = null, items, zone = null, deliveryMethod = 'basira' }) {
      const merchantId = requireMerchant();
      if (!items || !items.length) throw new Error('ORDER_NEEDS_ITEMS');

      // ١. احجز كل الكميات — لو وحدة فشلت، حرّر اللي انحجز وارفض
      const reserved = [];
      for (const it of items) {
        const ok = await inventory.reserve(it.variantId, it.quantity);
        if (!ok) {
          for (const r of reserved) await inventory.release(r.variantId, r.quantity);
          throw new Error('OUT_OF_STOCK:' + it.variantId);
        }
        reserved.push(it);
      }

      // ٢. كوّن الطلب
      const total = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
      const { data: order, error } = await client()
        .from('orders')
        .insert({
          merchant_id: merchantId, customer_id: customerId,
          conversation_id: conversationId, total, zone,
          delivery_method: deliveryMethod
        })
        .select().single();
      if (error) {
        for (const r of reserved) await inventory.release(r.variantId, r.quantity);
        throw new Error(error.message);
      }

      // ٣. أضف العناصر
      const rows = items.map(it => ({
        order_id: order.id, variant_id: it.variantId,
        merchant_id: merchantId, quantity: it.quantity, unit_price: it.unitPrice
      }));
      const { error: e2 } = await client().from('order_items').insert(rows);
      if (e2) throw new Error(e2.message);

      return order;
    },

    /* تغيير حالة الطلب — مع منطق المخزون الصحيح لكل انتقال */
    async setStatus(orderId, newStatus) {
      const merchantId = requireMerchant();

      // اجلب الطلب وعناصره
      const { data: order, error } = await client()
        .from('orders')
        .select('*, order_items(*)')
        .eq('id', orderId)
        .eq('merchant_id', merchantId)
        .single();
      if (error) throw new Error(error.message);

      // منطق المخزون حسب الانتقال:
      // done     → ثبّت البيع (اخصم من المخزون وحرّر الحجز)
      // canceled → حرّر الحجز فقط (الكمية ترجع متاحة)
      // rejected → الزبون رفض الاستلام: المنتج رجع، حرّر الحجز (موثّق منفصل عن الإلغاء)
      if (newStatus === 'done' && order.status !== 'done') {
        for (const it of order.order_items) {
          await inventory.commit(it.variant_id, it.quantity);
        }
      }
      if ((newStatus === 'canceled' || newStatus === 'rejected') && !['done', 'canceled', 'rejected'].includes(order.status)) {
        for (const it of order.order_items) {
          await inventory.release(it.variant_id, it.quantity);
        }
      }

      const { error: e2 } = await client()
        .from('orders')
        .update({ status: newStatus })
        .eq('id', orderId)
        .eq('merchant_id', merchantId);
      if (e2) throw new Error(e2.message);
      return true;
    }
  };

  /* ============================================================
     الواجهة العامة للطبقة
     ============================================================ */
  /* ============================================================
     CHANNELS — القنوات المربوطة (self-service)
     التوكنات تُخزّن بـ credentials؛ لا تُعاد للواجهة أبداً بالكامل.
     ============================================================ */
  const channels = {
    async list() {
      /* لا نُرجع credentials للواجهة — أمان */
      const { data, error } = await client()
        .from('channels')
        .select('id, type, page_id, handle, is_active, created_at')
        .eq('merchant_id', requireMerchant())
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return data;
    },

    async create({ type, pageId = null, handle = null, credentials = {} }) {
      const { data, error } = await client()
        .from('channels')
        .insert({
          merchant_id: requireMerchant(),
          type, page_id: pageId, handle, credentials
        })
        .select('id, type, page_id, handle, is_active, created_at')
        .single();
      if (error) throw new Error(error.message);
      return data;
    },

    async setActive(channelId, isActive) {
      const { error } = await client()
        .from('channels')
        .update({ is_active: isActive })
        .eq('id', channelId)
        .eq('merchant_id', requireMerchant());
      if (error) throw new Error(error.message);
      return true;
    },

    async remove(channelId) {
      const { error } = await client()
        .from('channels')
        .delete()
        .eq('id', channelId)
        .eq('merchant_id', requireMerchant());
      if (error) throw new Error(error.message);
      return true;
    }
  };

  /* ============================================================
     AI TEAM — فريق الذكاء (موظفون بأدوار)
     ============================================================ */
  const aiTeam = {
    async list() {
      const { data, error } = await client()
        .from('ai_agents')
        .select('*')
        .eq('merchant_id', requireMerchant())
        .order('sort_order', { ascending: true });
      if (error) throw new Error(error.message);
      return data;
    },

    async create({ role, displayName, icon = '🤖', tone = 'dialect', persona = null, handoff = 'auto', sortOrder = 0 }) {
      const { data, error } = await client()
        .from('ai_agents')
        .insert({
          merchant_id: requireMerchant(),
          role, display_name: displayName, icon, tone, persona, handoff,
          sort_order: sortOrder, is_active: true
        })
        .select().single();
      if (error) throw new Error(error.message);
      return data;
    },

    async update(agentId, fields) {
      const { data, error } = await client()
        .from('ai_agents')
        .update(fields)
        .eq('id', agentId)
        .eq('merchant_id', requireMerchant())
        .select().single();
      if (error) throw new Error(error.message);
      return data;
    },

    async setActive(agentId, isActive) {
      return await aiTeam.update(agentId, { is_active: isActive });
    },

    async remove(agentId) {
      const { error } = await client()
        .from('ai_agents')
        .delete()
        .eq('id', agentId)
        .eq('merchant_id', requireMerchant());
      if (error) throw new Error(error.message);
      return true;
    }
  };

  /* ============================================================
     KNOWLEDGE — معلومات المتجر و FAQ (دفتر معرفة الموظف)
     ============================================================ */
  const knowledge = {
    /* معلومات المتجر (صف واحد — upsert) */
    async getInfo() {
      const { data, error } = await client()
        .from('store_info')
        .select('*')
        .eq('merchant_id', requireMerchant())
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    },

    async saveInfo(fields) {
      const merchantId = requireMerchant();
      const { data, error } = await client()
        .from('store_info')
        .upsert({ merchant_id: merchantId, ...fields }, { onConflict: 'merchant_id' })
        .select().single();
      if (error) throw new Error(error.message);
      return data;
    },

    /* أسئلة وأجوبة */
    async listFaq() {
      const { data, error } = await client()
        .from('store_faq')
        .select('*')
        .eq('merchant_id', requireMerchant())
        .order('sort_order', { ascending: true });
      if (error) throw new Error(error.message);
      return data;
    },

    async addFaq({ question, answer, sortOrder = 0 }) {
      const { data, error } = await client()
        .from('store_faq')
        .insert({ merchant_id: requireMerchant(), question, answer, sort_order: sortOrder })
        .select().single();
      if (error) throw new Error(error.message);
      return data;
    },

    async updateFaq(faqId, fields) {
      const { data, error } = await client()
        .from('store_faq')
        .update(fields)
        .eq('id', faqId)
        .eq('merchant_id', requireMerchant())
        .select().single();
      if (error) throw new Error(error.message);
      return data;
    },

    async removeFaq(faqId) {
      const { error } = await client()
        .from('store_faq')
        .delete()
        .eq('id', faqId)
        .eq('merchant_id', requireMerchant());
      if (error) throw new Error(error.message);
      return true;
    }
  };

  /* ============================================================
     PRODUCT IMAGES — صور المنتج المتعددة (حتى ١٠)
     ============================================================ */
  const productImages = {
    async list(productId) {
      const { data, error } = await client()
        .from('product_images')
        .select('*')
        .eq('product_id', productId)
        .eq('merchant_id', requireMerchant())
        .order('sort_order', { ascending: true });
      if (error) throw new Error(error.message);
      return data;
    },

    async add(productId, imageUrl, sortOrder = 0) {
      const { data, error } = await client()
        .from('product_images')
        .insert({ product_id: productId, merchant_id: requireMerchant(), image_url: imageUrl, sort_order: sortOrder })
        .select().single();
      if (error) throw new Error(error.message);
      return data;
    },

    async remove(imageId) {
      const { error } = await client()
        .from('product_images')
        .delete()
        .eq('id', imageId)
        .eq('merchant_id', requireMerchant());
      if (error) throw new Error(error.message);
      return true;
    },

    /* يضبط الصورة الرئيسية (sort_order=0) ويحدّث products.image_url */
    async setPrimary(productId, imageId, imageUrl) {
      // كل صور المنتج ترتيبها +1، والمختارة 0
      const imgs = await productImages.list(productId);
      for (const im of imgs) {
        const newOrder = im.id === imageId ? 0 : (im.sort_order === 0 ? 1 : im.sort_order);
        if (newOrder !== im.sort_order) {
          await client().from('product_images').update({ sort_order: newOrder }).eq('id', im.id).eq('merchant_id', requireMerchant());
        }
      }
      await client().from('products').update({ image_url: imageUrl }).eq('id', productId).eq('merchant_id', requireMerchant());
      return true;
    }
  };

  return { init, auth, products, productImages, inventory, customers, conversations, orders, channels, aiTeam, knowledge };
})();
