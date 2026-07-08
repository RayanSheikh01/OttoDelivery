export interface LatLng {
  lat: number;
  lng: number;
}

export type OrderStatus =
  | "created"
  | "confirmed"
  | "routed"
  | "assigned"
  | "out_for_delivery"
  | "delivered"
  | "failed"
  | "cancelled"
  | "exception";

export interface OrderItem {
  sku?: string;
  name: string;
  qty: number;
}

export interface NotificationLog {
  notification_id: string;
  channel: "sms" | "email" | "push";
  to: string;
  body: string;
  status: string;
  at: string;
}

export interface TransactionLog {
  transaction_id: string;
  kind: "charge" | "refund";
  amount: number;
  currency: string;
  status: string;
  idempotency_key?: string;
  reason?: string;
  at: string;
  ref?: string; // charge id a refund points back at
}

export interface StatusChange {
  status: OrderStatus;
  at: string;
}

export interface Order {
  order_id: string;
  status: OrderStatus;
  items: OrderItem[];
  pickup?: LatLng;
  drop?: LatLng;
  drop_address?: string;
  assigned_vehicle?: string | null;
  eta?: string | null;
  status_history?: StatusChange[];
  notifications: NotificationLog[];
  transactions: TransactionLog[];
  created_at: string;
  updated_at: string;
  // free-form patch surface for fields the spec leaves open-ended
  [key: string]: unknown;
}

export type VehicleStatus = "idle" | "busy" | "offline";

export interface Vehicle {
  id: string;
  type: "courier" | "car" | "van" | "drone";
  location: LatLng;
  free_capacity: number;
  status: VehicleStatus;
  assigned_order?: string | null;
}
