import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import clsx from "clsx";

export type ButtonVariant = "primary" | "ghost" | "secondary" | "danger" | "warn";
export type ButtonSize = "md" | "small";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

/** Thin wrapper over existing `.btn` CSS variants. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "ghost", size = "md", className, type = "button", children, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={clsx(
          "btn",
          variant !== "ghost" && variant,
          variant === "ghost" && "ghost",
          size === "small" && "small",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
