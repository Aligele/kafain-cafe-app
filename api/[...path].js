import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://gvazpqznosqpzmuxcbip.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd2YXpwcXpub3NxcHptdXhjYmlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4MzUxODEsImV4cCI6MjEwMzQxMTE4MX0.61kM-AhFMFNyVobYrSF9D6iIWGnXvrhUSrQ2RKKZpEY";
const ADMIN_KEY = process.env.ADMIN_KEY || "Kafain2026!";
const TAX_RATE = 0.0;
const LOYALTY_RATE = 0.10;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function requireAdmin(req, res) {
  // Admin passcode check disabled per request — dashboard is open.
  return true;
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
    });
  });
}

export default async function handler(req, res) {
  const urlPath = (req.url || "/").split("?")[0];
  const route = urlPath.replace(/^\/api/, "") || "/";
  const method = req.method;

  try {
    // ---- Public ----
    if (route === "/products" && method === "GET") {
      const { data, error } = await supabase
        .from("products")
        .select("id, sku, name, category, price, stock_grams, grams_per_unit")
        .eq("active", true)
        .order("category").order("name");
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (route === "/employees" && method === "GET") {
      const { data, error } = await supabase
        .from("employees").select("id, name, role").eq("active", true).order("name");
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (route === "/my-orders" && method === "GET") {
      const employeeId = req.query.employee_id;
      const date = req.query.date || todayDate();
      if (!employeeId) return res.status(400).json({ error: "employee_id is required" });
      const { data, error } = await supabase
        .from("orders")
        .select("id, daily_number, subtotal, tax, total, payment_method, created_at")
        .eq("employee_id", employeeId)
        .gte("created_at", date + "T00:00:00")
        .lt("created_at", date + "T23:59:59.999")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (route === "/orders" && method === "POST") {
      const body = await readBody(req);
      const { items, channel, payment_method, employee_id, customer_email } = body;
      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Order must include at least one item." });
      if (!channel || !["counter", "online"].includes(channel)) return res.status(400).json({ error: "channel must be 'counter' or 'online'." });

      const productIds = items.map((i) => i.product_id);
      const { data: products, error: pErr } = await supabase
        .from("products").select("id, name, price, stock_grams, grams_per_unit").in("id", productIds);
      if (pErr) throw pErr;
      const productMap = Object.fromEntries(products.map((p) => [p.id, p]));

      let subtotal = 0;
      for (const item of items) {
        const p = productMap[item.product_id];
        if (!p) return res.status(400).json({ error: `Unknown product_id ${item.product_id}` });
        if (!item.quantity || item.quantity <= 0) return res.status(400).json({ error: "Each item needs a positive quantity." });
        const neededGrams = (p.grams_per_unit || 0) * item.quantity;
        if (neededGrams > p.stock_grams) return res.status(409).json({ error: `Not enough stock for ${p.name}.` });
        subtotal += p.price * item.quantity;
      }

      const tax = subtotal * TAX_RATE;
      const total = subtotal + tax;

      const todayStart = todayDate() + "T00:00:00";
      const { count: dayCount } = await supabase
        .from("orders").select("id", { count: "exact", head: true }).gte("created_at", todayStart);
      const dailyNumber = (dayCount || 0) + 1;

      let employeeName = null;
      if (employee_id) {
        const { data: emp } = await supabase.from("employees").select("name").eq("id", employee_id).single();
        employeeName = emp ? emp.name : null;
      }

      let customerId = null;
      if (customer_email) {
        const { data: existing } = await supabase.from("customers").select("id, loyalty_points").eq("email", customer_email).single();
        if (existing) {
          customerId = existing.id;
          await supabase.from("customers").update({ loyalty_points: existing.loyalty_points + subtotal * LOYALTY_RATE }).eq("id", customerId);
        } else {
          const { data: inserted } = await supabase.from("customers").insert({ email: customer_email, loyalty_points: subtotal * LOYALTY_RATE }).select("id").single();
          customerId = inserted.id;
        }
      }

      const { data: order, error: oErr } = await supabase.from("orders").insert({
        customer_id: customerId, employee_id: employee_id || null, channel,
        payment_method: payment_method || "unspecified", subtotal, tax, total, daily_number: dailyNumber,
      }).select("id, created_at").single();
      if (oErr) throw oErr;

      const receiptItems = [];
      for (const item of items) {
        const p = productMap[item.product_id];
        await supabase.from("order_items").insert({
          order_id: order.id, product_id: item.product_id, quantity: item.quantity, unit_price: p.price, notes: item.notes || null,
        });
        const neededGrams = (p.grams_per_unit || 0) * item.quantity;
        await supabase.from("products").update({ stock_grams: p.stock_grams - neededGrams }).eq("id", p.id);
        receiptItems.push({ name: p.name, quantity: item.quantity, unit_price: p.price, line_total: p.price * item.quantity });
      }

      return res.status(201).json({
        order_id: order.id, daily_number: dailyNumber, subtotal, tax, total,
        customer_id: customerId, employee_name: employeeName, created_at: order.created_at, items: receiptItems,
      });
    }

    // ---- Admin ----
    if (route === "/admin/summary" && method === "GET") {
      if (!requireAdmin(req, res)) return;
      const date = req.query.date || todayDate();
      const start = date + "T00:00:00", end = date + "T23:59:59.999";

      const { data: dayOrders, error } = await supabase
        .from("orders").select("id, subtotal, tax, total, channel, employee_id")
        .eq("status", "completed").gte("created_at", start).lt("created_at", end);
      if (error) throw error;

      const totals = dayOrders.reduce((acc, o) => ({
        orders_count: acc.orders_count + 1, subtotal: acc.subtotal + Number(o.subtotal),
        tax: acc.tax + Number(o.tax), total: acc.total + Number(o.total),
      }), { orders_count: 0, subtotal: 0, tax: 0, total: 0 });

      const { data: employees } = await supabase.from("employees").select("id, name");
      const empMap = Object.fromEntries((employees || []).map((e) => [e.id, e.name]));
      const byEmpAgg = {};
      for (const o of dayOrders) {
        const name = empMap[o.employee_id] || "Unassigned";
        if (!byEmpAgg[name]) byEmpAgg[name] = { employee_name: name, orders_count: 0, total: 0 };
        byEmpAgg[name].orders_count += 1;
        byEmpAgg[name].total += Number(o.total);
      }
      const by_employee = Object.values(byEmpAgg).sort((a, b) => b.total - a.total);

      const byChanAgg = {};
      for (const o of dayOrders) {
        if (!byChanAgg[o.channel]) byChanAgg[o.channel] = { channel: o.channel, orders_count: 0, total: 0 };
        byChanAgg[o.channel].orders_count += 1;
        byChanAgg[o.channel].total += Number(o.total);
      }
      const by_channel = Object.values(byChanAgg);

      const { data: closed } = await supabase.from("day_closes").select("*").eq("business_date", date).maybeSingle();

      return res.status(200).json({ date, ...totals, by_employee, by_channel, closed: closed || null });
    }

    if (route === "/admin/orders" && method === "GET") {
      if (!requireAdmin(req, res)) return;
      const date = req.query.date || todayDate();
      const start = date + "T00:00:00", end = date + "T23:59:59.999";
      const { data, error } = await supabase
        .from("orders").select("id, daily_number, total, payment_method, channel, created_at, employee_id")
        .gte("created_at", start).lt("created_at", end).order("created_at", { ascending: false });
      if (error) throw error;
      const { data: employees } = await supabase.from("employees").select("id, name");
      const empMap = Object.fromEntries((employees || []).map((e) => [e.id, e.name]));
      const withNames = data.map((o) => ({ ...o, employee_name: empMap[o.employee_id] || "Unassigned" }));
      return res.status(200).json(withNames);
    }

    if (route === "/admin/close-day" && method === "POST") {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      const date = body.business_date || todayDate();
      const closedBy = body.closed_by || "admin";

      const { data: existing } = await supabase.from("day_closes").select("*").eq("business_date", date).maybeSingle();
      if (existing) return res.status(409).json({ error: `${date} is already closed.`, close: existing });

      const start = date + "T00:00:00", end = date + "T23:59:59.999";
      const { data: dayOrders } = await supabase
        .from("orders").select("subtotal, tax, total").eq("status", "completed").gte("created_at", start).lt("created_at", end);
      const totals = (dayOrders || []).reduce((acc, o) => ({
        orders_count: acc.orders_count + 1, subtotal: acc.subtotal + Number(o.subtotal),
        tax: acc.tax + Number(o.tax), total: acc.total + Number(o.total),
      }), { orders_count: 0, subtotal: 0, tax: 0, total: 0 });

      const { data: result, error } = await supabase.from("day_closes").insert({
        business_date: date, orders_count: totals.orders_count, subtotal: totals.subtotal,
        tax: totals.tax, total: totals.total, closed_by: closedBy,
      }).select("*").single();
      if (error) throw error;
      return res.status(201).json(result);
    }

    if (route === "/admin/closes" && method === "GET") {
      if (!requireAdmin(req, res)) return;
      const { data, error } = await supabase.from("day_closes").select("*").order("business_date", { ascending: false }).limit(30);
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (route === "/admin/employees" && method === "POST") {
      if (!requireAdmin(req, res)) return;
      const { name, role } = await readBody(req);
      if (!name) return res.status(400).json({ error: "name is required" });
      const { error } = await supabase.from("employees").insert({ name, role: role || "waiter" });
      if (error) throw error;
      return res.status(201).json({ ok: true });
    }

    if (route === "/admin/products" && method === "GET") {
      if (!requireAdmin(req, res)) return;
      const { data, error } = await supabase.from("products").select("*").order("category").order("name");
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (route === "/admin/products" && method === "POST") {
      if (!requireAdmin(req, res)) return;
      const { sku, name, category, price, cost, stock_grams, grams_per_unit } = await readBody(req);
      if (!sku || !name || !category || price == null || cost == null) {
        return res.status(400).json({ error: "sku, name, category, price, and cost are required." });
      }
      const { error } = await supabase.from("products").insert({
        sku, name, category, price, cost, stock_grams: stock_grams || 0, grams_per_unit: grams_per_unit || 0,
      });
      if (error) throw error;
      return res.status(201).json({ ok: true });
    }

    if (route === "/admin/products/update" && method === "POST") {
      if (!requireAdmin(req, res)) return;
      const { id, price, active, add_stock_grams } = await readBody(req);
      if (!id) return res.status(400).json({ error: "id is required" });

      if (price != null) await supabase.from("products").update({ price }).eq("id", id);
      if (active != null) await supabase.from("products").update({ active: !!active }).eq("id", id);
      if (add_stock_grams) {
        const { data: p } = await supabase.from("products").select("stock_grams").eq("id", id).single();
        await supabase.from("products").update({ stock_grams: Number(p.stock_grams) + Number(add_stock_grams) }).eq("id", id);
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
