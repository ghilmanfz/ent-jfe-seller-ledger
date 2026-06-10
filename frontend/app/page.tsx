'use client';

import { useEffect, useState } from 'react';
import { CreateOrderForm } from '@/components/CreateOrderForm';
import { LiveIndicator } from '@/components/LiveIndicator';
import { OrdersTable } from '@/components/OrdersTable';
import { SettleCard } from '@/components/SettleCard';
import { SummaryCards } from '@/components/SummaryCards';
import { useOrders, useSummary } from '@/lib/hooks';

export default function DashboardPage() {
  const { data: summary } = useSummary();
  const { data: orderList, isValidating } = useOrders();

  // Stamp the end of each successful poll cycle for the "Live" indicator.
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  useEffect(() => {
    if (!isValidating && orderList) setUpdatedAt(new Date());
  }, [isValidating, orderList]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Seller dashboard</h1>
          <p className="text-sm text-slate-500">
            Every number below is derived from the immutable event log.
          </p>
        </div>
        <LiveIndicator updatedAt={updatedAt} />
      </div>

      <SummaryCards summary={summary} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <CreateOrderForm />
        <SettleCard />
      </div>

      <OrdersTable orders={orderList?.orders} />
    </div>
  );
}
