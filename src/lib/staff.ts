/* The business Variantage staff sign in under.

   Every user row needs a business, so staff have one of their own. It is not a
   customer: it is never billed, its books stay writable without a card, and it
   is left out of the admin figures so it cannot pass for a paying account. */
export const STAFF_BUSINESS_ID = 'variantage-staff';

export const isStaffBusiness = (businessId: string): boolean => businessId === STAFF_BUSINESS_ID;
