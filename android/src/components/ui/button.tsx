import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";

// RememberMe UI primitive (adapted from the web app's shadcn-style button).
// Phase 5 Task 1: plain semantic CSS classes replace cva/Tailwind utilities —
// no cva, no Slot, no Tailwind. `variant`/`size` map 1:1 to `.btn-*` classes
// defined in global.css; behavior, props and 44px touch targets are unchanged.
const BUTTON_VARIANTS = {
	default: "btn-primary",
	destructive: "btn-destructive",
	outline: "btn-outline",
	secondary: "btn-secondary",
	ghost: "btn-ghost",
	link: "btn-link",
} as const;

const BUTTON_SIZES = {
	default: "btn-size-default",
	sm: "btn-size-sm",
	lg: "btn-size-lg",
	icon: "btn-size-icon",
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;
export type ButtonSize = keyof typeof BUTTON_SIZES;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant;
	size?: ButtonSize;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant = "default", size = "default", ...props }, ref) => (
		<button
			ref={ref}
			className={cn("btn", BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
			{...props}
		/>
	),
);
Button.displayName = "Button";

export { Button };
