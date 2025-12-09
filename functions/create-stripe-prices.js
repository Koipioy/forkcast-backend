/**
 * Script to create Stripe products and prices for Forkcast subscriptions
 * 
 * Usage:
 *   node create-stripe-prices.js
 * 
 * Make sure STRIPE_SECRET is set in your environment or Firebase config
 */

const Stripe = require('stripe');

// Get Stripe secret key from environment variable
// You can get it from Firebase config: firebase functions:config:get
const STRIPE_SECRET = process.env.STRIPE_SECRET;

if (!STRIPE_SECRET) {
  console.error('❌ Error: STRIPE_SECRET not found.');
  console.error('\nSet it with:');
  console.error('  export STRIPE_SECRET="sk_test_YOUR_SECRET_KEY_HERE"');
  console.error('\nOr run:');
  console.error('  STRIPE_SECRET="sk_test_YOUR_SECRET_KEY_HERE" node create-stripe-prices.js');
  console.error('\nGet your Stripe secret key from: https://dashboard.stripe.com/apikeys');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET);

async function createProductsAndPrices() {
  try {
    console.log('🚀 Creating Stripe products and prices...\n');

    // Create Monthly Subscription Product
    console.log('Creating Monthly Subscription product...');
    const monthlyProduct = await stripe.products.create({
      name: 'Forkcast Monthly Subscription',
      description: 'Monthly subscription to Forkcast',
    });

    const monthlyPrice = await stripe.prices.create({
      product: monthlyProduct.id,
      unit_amount: 999, // $9.99 in cents
      currency: 'usd',
      recurring: {
        interval: 'month',
      },
    });

    console.log('✅ Monthly Subscription created:');
    console.log(`   Product ID: ${monthlyProduct.id}`);
    console.log(`   Price ID: ${monthlyPrice.id}\n`);

    // Create Yearly Subscription Product
    console.log('Creating Yearly Subscription product...');
    const yearlyProduct = await stripe.products.create({
      name: 'Forkcast Yearly Subscription',
      description: 'Yearly subscription to Forkcast',
    });

    const yearlyPrice = await stripe.prices.create({
      product: yearlyProduct.id,
      unit_amount: 9999, // $99.99 in cents
      currency: 'usd',
      recurring: {
        interval: 'year',
      },
    });

    console.log('✅ Yearly Subscription created:');
    console.log(`   Product ID: ${yearlyProduct.id}`);
    console.log(`   Price ID: ${yearlyPrice.id}\n`);

    // Output for easy copy-paste
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 Copy these Price IDs to your frontend:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('Monthly Price ID:');
    console.log(`  ${monthlyPrice.id}\n`);
    console.log('Yearly Price ID:');
    console.log(`  ${yearlyPrice.id}\n`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Show what to update in the code
    console.log('📝 Update StripeSubscriptionPage.tsx with these values:\n');
    console.log('const PLANS: SubscriptionPlan[] = [');
    console.log('  {');
    console.log('    id: "monthly",');
    console.log('    name: "Monthly",');
    console.log('    price: "$9.99",');
    console.log(`    priceId: "${monthlyPrice.id}",`);
    console.log('    interval: "month",');
    console.log('  },');
    console.log('  {');
    console.log('    id: "yearly",');
    console.log('    name: "Yearly",');
    console.log('    price: "$99.99",');
    console.log(`    priceId: "${yearlyPrice.id}",`);
    console.log('    interval: "year",');
    console.log('  },');
    console.log('];\n');

    console.log('✅ Done! Products and prices created successfully.');

  } catch (error) {
    console.error('❌ Error creating products/prices:', error.message);
    
    if (error.type === 'StripeAuthenticationError') {
      console.error('\n💡 Make sure your Stripe secret key is correct.');
    } else if (error.type === 'StripeInvalidRequestError') {
      console.error('\n💡 Check that the product/price data is valid.');
    }
    
    process.exit(1);
  }
}

// Run the script
createProductsAndPrices();

