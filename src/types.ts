export type CartItemStatus = "proposed" | "approved" | "cancelled" | "purchased";
export type BillingPeriod = "monthly" | "yearly";

export interface AgentHandshakeRequest {
  pairing_token: string;
  instance_id: string;
  software_version?: string;
  capabilities: string[];
}

export interface AgentTokenResponse {
  agent_id: string;
  agent_access_token: string;
  token_type: "bearer";
  expires_at: string;
}

export interface AgentHeartbeatResponse {
  agent_id: string;
  connection_state: "online";
  server_time: string;
}

export interface CartItemCreate {
  title: string;
  description: string;
  product_url: string;
  merchant?: string;
  reason: string;
  quantity: number;
  unit_price: string;
  currency: string;
  billing_period: BillingPeriod | null;
  account: {
    email: string;
    password: string;
    login_url?: string;
  };
}

export interface CartItemRead {
  id: string;
  agent_id: string;
  credential_id: string;
  selected_payment_method_id: string | null;
  title: string;
  description: string;
  product_url: string;
  merchant: string | null;
  reason: string;
  quantity: number;
  unit_price: string;
  total_amount: string;
  currency: string;
  billing_period: BillingPeriod | null;
  status: CartItemStatus;
  decision_note: string | null;
  account_email: string;
  login_url: string | null;
  approved_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

export interface PurchaseComplete {
  amount: string;
  currency: string;
  provider_reference: string;
  receipt_url?: string;
  next_billing_at?: string;
}

export interface SubscriptionRead {
  id: string;
  purchase_id: string;
  agent_id: string;
  title: string;
  billing_period: BillingPeriod;
  status: "active" | "paused" | "cancelled";
  amount: string;
  currency: string;
  next_billing_at: string | null;
  created_at: string;
}

export interface PurchaseRead {
  id: string;
  cart_item_id: string;
  agent_id: string;
  payment_method_id: string;
  title: string;
  description: string;
  product_url: string;
  status: "completed" | "failed" | "refunded";
  amount: string;
  currency: string;
  provider_reference: string;
  receipt_url: string | null;
  account_email: string;
  purchased_at: string;
  subscription: SubscriptionRead | null;
}
